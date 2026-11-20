#!/usr/bin/env bash
#
# Deploy lorem-host on the host that runs it.
#
# Two layouts, decided once below and read by every later step. Standalone: the
# checkout this script sits in is the one to deploy. Pinned: this script's
# checkout is core, held as a git submodule inside a site's repository, and the
# site's repository is the one fetched, checked and fast-forwarded, with core
# following the commit it records.
#
# Runs where the container runs, because that is the only machine where the
# compose network, the secrets file and the published port all exist. It does
# NOT run the test gate: a deploy host is not assumed to carry Node 22 or pnpm
# (see docs/deployment.md, Migrations), so `pnpm check` and `pnpm test` belong on a developer
# machine or in CI. What this enforces instead is that the commit being deployed
# is reachable from origin/main, which means it went through a pull request.
#
# The ordering is not arbitrary. Everything that can fail without touching the
# running site fails first: the fetch, the fast-forward check, the secrets
# validation. Only then does the migration run, and only after it exits zero
# does the container restart. A deploy that dies before the migration step has
# changed nothing a visitor could notice.
#
#   deploy/deploy.sh              # interactive
#   deploy/deploy.sh --yes        # automation (implied when stdin is not a TTY)
#   deploy/deploy.sh --dry-run    # print the plan, change nothing
#   deploy/deploy.sh --rollback   # back to the commit this last replaced
#
# Exit codes are distinct so a caller can tell what went wrong without parsing
# prose: 1 usage, 2 precondition, 3 fetch/auth, 4 config, 5 migration,
# 6 build or start, 7 post-deploy verification.

set -euo pipefail

# Bash reads a script by byte offset as it goes, and this script rewrites itself:
# a deploy whose range touches deploy/deploy.sh replaces the file underneath the
# running process at `checkout_target`. Every later read then lands at an offset
# that means something different, which is a syntax error at best and the wrong
# command at worst. So run from a copy nothing will touch.
#
# The copy does not make the new logic take effect on the run that fetched it —
# the function bodies were parsed from the old file before the fast-forward, and
# no arrangement fixes that, because code cannot run before it is fetched. What
# it fixes is the corruption. When deploy.sh itself changes, the deploy reports
# so and the next run is the one that behaves differently.
if [[ -z ${LOREM_DEPLOY_SNAPSHOT:-} ]]; then
	LOREM_DEPLOY_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
	export LOREM_DEPLOY_ROOT
	export LOREM_DEPLOY_SNAPSHOT=1
	snapshot=$(mktemp "${TMPDIR:-/tmp}/lorem-deploy.XXXXXX") || exit 1
	cat -- "${BASH_SOURCE[0]}" >"$snapshot" || {
		rm -f -- "$snapshot"
		exit 1
	}
	exec bash "$snapshot" "$@"
fi

# Unlink the snapshot now rather than on exit: bash holds the descriptor open, so
# it keeps reading fine, and this way no interrupt or failure path can leave a
# copy behind in /tmp. Gated on the sentinel the re-exec sets, because reaching
# here any other way means $0 is the checkout's own file.
if [[ -n ${LOREM_DEPLOY_SNAPSHOT:-} ]]; then
	rm -f -- "$0"
fi
unset LOREM_DEPLOY_SNAPSHOT

# ---------------------------------------------------------------- layout ----

# Asked of git rather than inferred from directory names: a superproject is the
# repository that records this checkout as a submodule, wherever either sits.
# CORE_ROOT is where the Dockerfile, the compose file and this script live;
# REPO_ROOT is what gets deployed. CORE_PATH is core's path inside REPO_ROOT,
# empty when the two are one repository.
CORE_ROOT=$LOREM_DEPLOY_ROOT
super=$(git -C "$CORE_ROOT" rev-parse --show-superproject-working-tree 2>/dev/null || true)
if [[ -n $super ]]; then
	LAYOUT=pinned
	REPO_ROOT=$super
	core_top=$(git -C "$CORE_ROOT" rev-parse --show-toplevel)
	CORE_PATH=${core_top#"$super"/}
else
	LAYOUT=standalone
	REPO_ROOT=$CORE_ROOT
	CORE_PATH=''
fi
# The core commit this process was started from, which is where its snapshot of
# this script came from (preflight refuses a core tree that differs from it).
# The core range a deploy performs runs from here, not from the parent's commit:
# a run that resumes a stopped sync, or advances past one, starts with the
# parent already naming a newer core than the one checked out.
CORE_START=$(git -C "$CORE_ROOT" rev-parse HEAD)
readonly LAYOUT REPO_ROOT CORE_ROOT CORE_PATH CORE_START
unset super core_top

# Where this host is, as opposed to what to deploy: install paths, the publish
# address, the project name. Read before the constants below so they can default
# through it, and exported rather than merely set, because `docker compose`
# substitutes from the environment and would otherwise resolve a different
# secrets path than this script checks. Absent on a host that runs the defaults,
# which is why it is not an error.
if [[ -f "$LOREM_DEPLOY_ROOT/deploy/deploy.env" ]]; then
	set -a
	# shellcheck disable=SC1091
	. "$LOREM_DEPLOY_ROOT/deploy/deploy.env"
	set +a
fi

readonly E_USAGE=1 E_PRECONDITION=2 E_FETCH=3 E_CONFIG=4
readonly E_MIGRATE=5 E_START=6 E_VERIFY=7

# The same defaults docker-compose.yml substitutes, so a host that sets nothing
# gets what it has always had, and one that sets LOREM_SECRETS_DIR moves the
# compose file and this script's checks together.
readonly SECRETS_DIR=${LOREM_SECRETS_DIR:-/data/secrets/lorem-host}
readonly SECRETS_FILE=$SECRETS_DIR/.env
# Split from the app's on purpose (see docker-compose.yml), and checked here
# because a deployment that gets the two-file credential split wrong starts a
# database the app cannot authenticate against.
readonly PG_SECRETS_FILE=$SECRETS_DIR/postgres.env
# Prepended to every compose call below, which `compose` runs from CORE_ROOT. sudo's env_reset drops the variables
# exported above, so compose gets them as files instead. deploy/deploy.env goes
# last so its host facts override the secrets file, which is the precedence the
# exported environment gives them when no sudo is involved.
#
# Keep secrets out of docker-compose.yml substitutions: a `${SMTP_PASSWORD}` there
# would resolve into `docker compose config` output.
COMPOSE=(--env-file "$SECRETS_FILE")
[[ -f "$LOREM_DEPLOY_ROOT/deploy/deploy.env" ]] &&
	COMPOSE+=(--env-file "$LOREM_DEPLOY_ROOT/deploy/deploy.env")
readonly COMPOSE
# Must match the service key in docker-compose.yml: `compose logs` on a name
# that is not there prints its own error instead of the logs, on the one path
# where the logs are the whole point.
readonly APP_SERVICE=lorem-host
# Probed at whatever compose publishes. 0.0.0.0 is a bind address rather than a
# destination, so the probe walks back to loopback, which is what it means here.
probe_host=${LOREM_BIND_ADDR:-127.0.0.1}
[[ $probe_host == 0.0.0.0 ]] && probe_host=127.0.0.1
readonly PROBE_ORIGIN=http://${probe_host}:${LOREM_HOST_PORT:-5880}
readonly HEALTH_URL=$PROBE_ORIGIN/healthz
readonly SITE_URL=$PROBE_ORIGIN/
readonly HEALTH_TIMEOUT=${LOREM_HEALTH_TIMEOUT:-120}

# The deploying user owns the checkout but not the docker socket or the secrets
# file, and on a shared host both stay root-owned: adding the user to the docker
# group would hand them root over every tenant's containers, and the secrets file
# is 0600 root:root because compose is the only thing that needs to read it. So
# git runs as the user, keeping the work tree's ownership intact, and exactly two
# operations borrow sudo — talking to the daemon, and reading that one file.
DOCKER=(docker)
PRIV=()


REF=origin/main
ASSUME_YES=0
DRY_RUN=0
DO_MIGRATE=1
DO_VERIFY=1
ROLLBACK=0
QUIET=0
GATE_ON=0

# ---------------------------------------------------------------- output ----

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
	C_RED=$'\033[31m' C_YELLOW=$'\033[33m' C_GREEN=$'\033[32m' C_DIM=$'\033[2m' C_OFF=$'\033[0m'
else
	C_RED='' C_YELLOW='' C_GREEN='' C_DIM='' C_OFF=''
fi

# Diagnostics go to stderr so stdout stays parseable.
say() { ((QUIET)) || printf '%s\n' "$*" >&2; }
step() { ((QUIET)) || printf '\n%s==>%s %s\n' "$C_GREEN" "$C_OFF" "$*" >&2; }
warn() { printf '%swarning:%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }

# Every failure names what broke, why, and what to do next. Somebody is reading
# this at 03:00 with the site down.
die() {
	local code=$1
	shift
	printf '%serror:%s %s\n' "$C_RED" "$C_OFF" "$1" >&2
	shift
	for line in "$@"; do printf '       %s\n' "$line" >&2; done
	exit "$code"
}

usage() {
	cat <<'EOF'
Deploy lorem-host from origin/main.

Usage: deploy/deploy.sh [options]

Options:
  -y, --yes         Do not prompt. Implied when stdin is not a TTY.
  -n, --dry-run     Print the plan and exit without changing anything.
      --ref REF     Deploy REF instead of origin/main. Must be reachable
                    from origin/main, so it still went through review.
      --rollback    Redeploy the commit this script last replaced.
      --no-migrate  Skip the migration step. Only when you know the schema
                    is already current; the app will not tell you if it is not.
      --no-verify   Skip the post-deploy checks. Not recommended.
  -q, --quiet       Warnings and errors only.
      --no-color    Disable colour. NO_COLOR is honoured too.
  -h, --help        This.

Exit codes:
  0 success   2 precondition   4 config      6 build/start
  1 usage     3 fetch/auth     5 migration   7 verification
EOF
}

# ------------------------------------------------------------------ args ----

while [[ $# -gt 0 ]]; do
	case "$1" in
		-y | --yes) ASSUME_YES=1 ;;
		-n | --dry-run) DRY_RUN=1 ;;
		--ref)
			[[ $# -ge 2 ]] || die $E_USAGE "--ref needs a value." "Example: --ref v1.2.0"
			REF=$2
			shift
			;;
		--rollback) ROLLBACK=1 ;;
		--no-migrate) DO_MIGRATE=0 ;;
		--no-verify) DO_VERIFY=0 ;;
		-q | --quiet) QUIET=1 ;;
		--no-color) C_RED='' C_YELLOW='' C_GREEN='' C_DIM='' C_OFF='' ;;
		-h | --help)
			usage
			exit 0
			;;
		*) die $E_USAGE "Unknown option: $1" "Run 'deploy/deploy.sh --help'." ;;
	esac
	shift
done

# A pipeline or a cron job has nobody to answer the prompt.
[[ -t 0 ]] || ASSUME_YES=1

confirm() {
	((ASSUME_YES)) && return 0
	local reply
	printf '%s [y/N] ' "$1" >&2
	read -r reply || return 1
	[[ $reply == [yY] || $reply == [yY][eE][sS] ]]
}

# Each mutating step is idempotent on its own, so an interrupt between two of
# them leaves nothing half-written and the next run picks up where this stopped.
trap 'printf "\n%sinterrupted%s — nothing further will run.\n" "$C_YELLOW" "$C_OFF" >&2; exit 130' INT TERM

# ------------------------------------------------------------- preflight ----

# Relative to core for the diff, and to REPO_ROOT for the notice, so the notice
# names the file somebody would edit rather than the snapshot this process reads.
readonly SELF_PATH='deploy/deploy.sh'
readonly SELF_SHOWN=${CORE_PATH:+$CORE_PATH/}$SELF_PATH
readonly MIGRATIONS_PATH='src/lib/server/migrations.ts'
# Only a release goes on a site: a core commit between tags has no changelog
# entry and no upgrade promise behind it.
readonly CORE_TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'
SELF_CHANGED=0
CORE_TAG=''
cd "$REPO_ROOT"

core_git() { git -C "$CORE_ROOT" "$@"; }

# Core's commit as a commit of the deployed repository records it. In the
# standalone layout the two are one repository, so it is the commit itself, and
# every core comparison below reads the same either way.
core_at() {
	if [[ $LAYOUT == standalone ]]; then
		git rev-parse --verify --quiet "$1^{commit}"
		return
	fi
	git rev-parse --verify --quiet "$1:$CORE_PATH" || die $E_PRECONDITION \
		"$(git rev-parse --short "$1") records no core at $CORE_PATH." \
		"A pinned deploy needs the submodule in every commit it deploys."
}

# The release tag on a core commit, or nothing.
core_tag_of() {
	core_git tag --points-at "$1" 2>/dev/null | grep -E "$CORE_TAG_PATTERN" | sort -V | tail -1 || true
}

# Run from core's directory, where docker-compose.yml and the Dockerfile are, so
# relative paths in it (the build context, SKIN_DIR) resolve the same in both
# layouts.
compose() { (cd "$CORE_ROOT" && "${DOCKER[@]}" compose "${COMPOSE[@]}" "$@"); }

readonly STATE_DIR="$REPO_ROOT/.git/lorem-deploy"
readonly PRIOR_FILE="$STATE_DIR/prior-commit"
# "<target> <core> <predecessor> <from>": the parent commit a run is moving to,
# the core commit checked out when it started, the release --rollback returns to
# once the move lands, and the parent commit being replaced. Written before the
# parent moves and removed once core is verified at the target's pin, so an
# interrupt on either side of the move leaves a record that says which side:
# HEAD still at <from> means nothing moved, HEAD at <target> means the move
# landed and <predecessor> applies even if prior-commit was never written.
readonly TRANSITION_FILE="$STATE_DIR/core-transition"
# The landed record a pending intent replaced. A run that starts from an
# unfinished transition and is stopped before its own move leaves the parent at
# <from> with the drift the earlier record owns; without that record the drift
# is unexplained, and rollback and retry both refuse it as a dirty tree.
readonly ACCEPTED_FILE="$STATE_DIR/core-transition.accepted"

# The record that owns the current parent/core state: the latest one when its
# move landed, or the one it replaced when the latest is an intent whose parent
# never moved. Fails when neither describes HEAD.
landed_record() {
	[[ -f $TRANSITION_FILE ]] || return 1
	local head file target core predecessor from
	head=$(git rev-parse HEAD)
	for file in "$TRANSITION_FILE" "$ACCEPTED_FILE"; do
		[[ -f $file ]] && read -r target core predecessor from <"$file" || return 1
		if [[ -n $from && $head == "$target" && $target != "$from" ]]; then
			printf '%s %s %s %s\n' "$target" "$core" "$predecessor" "$from"
			return 0
		fi
		[[ $head == "$from" ]] || return 1
	done
	return 1
}

clear_transition() {
	rm -f "$ACCEPTED_FILE" "$TRANSITION_FILE"
}

# Prints the record's field when the parent moved to its target and the run that
# moved it never finished; fails otherwise. A record whose HEAD is anything else
# describes a move that did not happen, and the next move overwrites it.
moved_transition() {
	local record target core predecessor from
	record=$(landed_record) || return 1
	read -r target core predecessor from <<<"$record"
	case $1 in
		core) printf '%s' "$core" ;;
		predecessor) printf '%s' "$predecessor" ;;
	esac
}

# The release --rollback returns to. An unfinished move's record outranks
# prior-commit, which the interrupted run may not have reached.
recorded_prior() {
	moved_transition predecessor && return 0
	[[ -f $PRIOR_FILE ]] && cat "$PRIOR_FILE"
}

# True when the only difference in the work tree is the gitlink drift a stopped
# deploy left behind: the parent at the commit it recorded moving to, core still
# at the commit it recorded leaving, and nothing modified or untracked inside
# core. Anything else (a file edit, a staged gitlink, core moved by hand to a
# third commit) is not this script's to explain and stays a dirty tree.
interrupted_transition() {
	[[ $LAYOUT == pinned ]] || return 1
	local core status
	core=$(moved_transition core) || return 1
	[[ $(core_git rev-parse HEAD) == "$core" ]] || return 1
	status=$(tree_status)
	[[ $status == "1 .M SC.. "*" $CORE_PATH" && $status != *$'\n'* ]] || return 1
	say "  core is at ${core:0:7}, where an earlier deploy to $(git rev-parse --short HEAD) stopped"
	say "  before syncing it; continuing will finish or roll back that transition"
}

# What is actually modified, staged or untracked, whatever the config says to
# show. `submodule.<name>.ignore`, `diff.ignoreSubmodules` and
# `status.showUntrackedFiles` all hide real edits from a plain `git status`, and
# each is a supported setting an operator may have for their own reasons; the
# flags here override every one of them.
tree_status() {
	git -C "${1:-.}" status --porcelain=v2 --ignore-submodules=none --untracked-files=normal
}

# assume-unchanged and skip-worktree tell git to stop looking at a file, so every
# status check above reports it clean whatever it now holds, and an edited
# migration would build under the release's stamp. Clearing either bit is the
# operator's decision, so a deploy refuses the checkout rather than trusting it
# or rewriting their index.
hinted_files() {
	git -C "${1:-.}" ls-files -v | sed -n 's/^[a-zS] //p'
}

# Core is asked directly as well as through the parent's gitlink entry, so the
# answer does not depend on how the parent summarizes a submodule.
dirty_tree() {
	[[ $LAYOUT == standalone || -z $(tree_status "$CORE_ROOT") ]] || return 0
	[[ -n $(tree_status) ]] && ! interrupted_transition
}

# Warms a sudo session when one is needed, so the password prompt (if any) lands
# here rather than between the migration and the restart.
warm_sudo() {
	sudo -n true 2>/dev/null && return 0
	[[ -t 0 ]] || return 1
	say "  sudo password needed for the docker socket and the secrets file"
	sudo -v 2>/dev/null
}

resolve_privileges() {
	if ! docker info >/dev/null 2>&1; then
		if warm_sudo && sudo docker info >/dev/null 2>&1; then
			DOCKER=(sudo docker)
		else
			die $E_PRECONDITION \
				"Cannot reach the docker daemon, with or without sudo." \
				"This user is not in the docker group, which is correct on a shared" \
				"host: that group is root over every tenant's containers. So the" \
				"deploy needs sudo. Grant NOPASSWD for docker, or run 'sudo -v' first."
		fi
	fi

	if [[ ! -r $SECRETS_FILE ]]; then
		if warm_sudo && sudo test -r "$SECRETS_FILE"; then
			PRIV=(sudo)
		else
			die $E_CONFIG \
				"Cannot read $SECRETS_FILE, with or without sudo." \
				"It is 0600 root:root by design. Check the path exists and that this" \
				"user has sudo; do not loosen the file's mode to work around this."
		fi
	fi
}

preflight() {
	step "Preflight"

	[[ $EUID -ne 0 ]] || die $E_PRECONDITION \
		"Refusing to run as root." \
		"The compose stack is owned by the deploying user, and root would" \
		"leave root-owned files in the work tree. Run as that user."

	local missing=()
	for cmd in git docker curl; do
		command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
	done
	((${#missing[@]} == 0)) || die $E_PRECONDITION \
		"Missing required command(s): ${missing[*]}" \
		"This script runs on the deploy host, not a developer machine."

	docker compose version >/dev/null 2>&1 || die $E_PRECONDITION \
		"'docker compose' is unavailable." \
		"The v1 'docker-compose' binary is not a substitute; this uses profiles."

	resolve_privileges

	git rev-parse --git-dir >/dev/null 2>&1 || die $E_PRECONDITION \
		"$REPO_ROOT is not a git checkout." \
		"Expected the deploy checkout, e.g. /srv/community/www, or core's" \
		"submodule inside it."

	[[ -f $CORE_ROOT/docker-compose.yml ]] || die $E_PRECONDITION \
		"No docker-compose.yml in $CORE_ROOT." \
		"This script must live in deploy/ inside core's checkout."

	if [[ $LAYOUT == pinned ]]; then
		say "  layout: pinned, deploying $REPO_ROOT with core at $CORE_PATH"
	else
		say "  layout: standalone, deploying $REPO_ROOT"
	fi

	local hinted
	hinted=$(
		hinted_files
		[[ $LAYOUT == standalone ]] || hinted_files "$CORE_ROOT" | sed "s|^|$CORE_PATH/|"
	)
	if [[ -n $hinted ]]; then
		printf '%s\n' "$hinted" | sed 's/^/  /' >&2
		die $E_PRECONDITION \
			"Git is told not to check the files above (assume-unchanged or skip-worktree)." \
			"An edit to one would build under the release's stamp with nothing reporting it." \
			"Clear the bit with 'git update-index --no-assume-unchanged --no-skip-worktree <path>'" \
			"in the repository that holds it, check what it shows, then re-run."
	fi

	# A dirty tree means somebody edited on the host. Fast-forwarding over it
	# either fails or silently discards their work; both deserve a human.
	if dirty_tree; then
		git status --short --ignore-submodules=none --untracked-files=normal >&2
		[[ $LAYOUT == standalone ]] ||
			core_git status --short --ignore-submodules=none --untracked-files=normal | sed "s|^|  $CORE_PATH: |" >&2
		die $E_PRECONDITION \
			"The work tree has uncommitted changes." \
			"Deploying would fast-forward over them. Commit, stash or discard" \
			"them, and consider why an edit was made on the host at all."
	fi

	local branch
	branch=$(git rev-parse --abbrev-ref HEAD)
	[[ $branch == main || $ROLLBACK -eq 1 ]] || die $E_PRECONDITION \
		"On branch '$branch', not main." \
		"Run: git switch main"

	say "  ${C_DIM}${branch} at $(git rev-parse --short HEAD)${C_OFF}"
}

# ----------------------------------------------------------------- fetch ----

fetch_origin() {
	step "Fetching origin"
	fetch_repo "$REPO_ROOT"
	# Tags as well, because the pin check reads them, and with them the commit
	# of every release this deploy could be asked to put on the site.
	[[ $LAYOUT == standalone ]] || fetch_repo "$CORE_ROOT" --tags
}

fetch_repo() {
	local dir=$1 out
	shift
	if ! out=$(git -C "$dir" fetch --prune "$@" origin 2>&1); then
		if [[ $out == *"Permission denied (publickey)"* ]]; then
			die $E_FETCH \
				"This host cannot read $dir's origin (publickey denied)." \
				"It has no credential of its own, so the fetch only works while a" \
				"human forwards an agent (ssh -A), so it stops when they log out." \
				"Fix: add a read-only deploy key for this host and point the" \
				"user's ssh config at it. Until then, deploy from a forwarded session."
		fi
		printf '%s\n' "$out" >&2
		die $E_FETCH "git fetch failed in $dir." "See the output above."
	fi
}

# ---------------------------------------------------------------- target ----

resolve_target() {
	if ((ROLLBACK)); then
		TARGET=$(recorded_prior) && [[ -n $TARGET ]] || die $E_PRECONDITION \
			"No prior deployment recorded, so there is nothing to roll back to." \
			"This script writes $PRIOR_FILE whenever a deploy moves the work tree."
		git cat-file -e "${TARGET}^{commit}" 2>/dev/null || die $E_PRECONDITION \
			"Recorded commit $TARGET is not in this repository."
		return
	fi

	TARGET=$(git rev-parse --verify "${REF}^{commit}" 2>/dev/null) || die $E_PRECONDITION \
		"Cannot resolve '$REF' to a commit." \
		"Check the ref name, or drop --ref to deploy origin/main."

	# Reaching origin/main is the only evidence available here that the commit
	# went through review and a green gate, because this host cannot run the
	# tests itself.
	git merge-base --is-ancestor "$TARGET" origin/main 2>/dev/null || die $E_PRECONDITION \
		"$REF is not reachable from origin/main." \
		"Deploying it would put code on the site that no pull request merged." \
		"Merge it first, or fix the ref."

	# A fast-forward to an ancestor of HEAD succeeds without moving, so a
	# checkout carrying a local commit, or a --ref behind it, would build the
	# local tree under TARGET's stamp after the pin check passed on TARGET's
	# core. Every later step reads TARGET as the tree that builds; this is what
	# makes that true.
	local head
	head=$(git rev-parse HEAD)
	git merge-base --is-ancestor "$head" "$TARGET" 2>/dev/null || die $E_PRECONDITION \
		"$(git rev-parse --short "$head") is not an ancestor of $REF ($(git rev-parse --short "$TARGET"))." \
		"The checkout holds commits $REF does not, so a fast-forward cannot reach it." \
		"Inspect 'git log $REF..HEAD' by hand. To go back a release, use --rollback."
}

# Checked against the commit the target records, before anything moves, so a
# refused pin leaves the work tree and the site as they were.
check_core_pin() {
	[[ $LAYOUT == pinned ]] || return 0
	local pin nearest
	pin=$(core_at "$TARGET")
	[[ -n $(core_tag_of "$pin") ]] && return 0
	nearest=$(core_git describe --tags --abbrev=0 --match 'v[0-9]*' "$pin" 2>/dev/null || echo 'none')
	die $E_PRECONDITION \
		"Core is pinned at ${pin:0:12}, which is not a release tag (nearest: $nearest)." \
		"A site deploys tagged core only. Move $CORE_PATH to a v{major}.{minor}.{patch}" \
		"tag in the site's repository, or tag this commit in core first."
}

show_plan() {
	local current
	current=$(git rev-parse HEAD)

	step "Plan"
	if [[ $current == "$TARGET" ]]; then
		say "  Already at $(git rev-parse --short "$TARGET"). Nothing to update."
		say "  ${C_DIM}Continuing anyway: the image, the schema and the secrets file${C_OFF}"
		say "  ${C_DIM}can all have moved without the commit moving.${C_OFF}"
	else
		say "  $(git rev-parse --short "$current") -> $(git rev-parse --short "$TARGET")"
		say ""
		git --no-pager log --oneline --no-decorate "${current}..${TARGET}" 2>/dev/null |
			sed 's/^/    /' >&2 || true
	fi

	local core_from=$CORE_START core_to
	core_to=$(core_at "$TARGET")
	if [[ $LAYOUT == pinned && $core_from != "$core_to" ]]; then
		say ""
		say "  core ${core_from:0:7} -> ${core_to:0:7} ($(core_tag_of "$core_to"))"
	fi

	# A schema change is the part of a deploy that does not come back by
	# checking the old commit out again, so it gets its own line rather than
	# being left to spot in the commit list. Read in core, where the file is,
	# across the core commits the two ends record. A diff that cannot run (the
	# old pin's objects are gone) warns too, because silence would claim no
	# schema change.
	if ! core_git diff --quiet "$core_from" "$core_to" -- "$MIGRATIONS_PATH" 2>/dev/null; then
		say ""
		warn "migrations.ts changes in this range. The schema moves forward and"
		warn "--rollback will NOT move it back."
	fi
}

# ---------------------------------------------------------------- config ----

# Held in memory for the life of the run so the privileged read happens once
# instead of once per key. Never exported, never printed.
SECRETS_BLOB=''

# Reads one key without sourcing the file: a secrets file is not a script, and
# sourcing it would execute whatever a stray backtick happened to contain.
env_value() {
	local key=$1 line
	line=$(grep -E "^[[:space:]]*${key}=" <<<"$SECRETS_BLOB" | tail -1) || return 1
	line=${line#*=}
	line=${line%\"} line=${line#\"}
	line=${line%\'} line=${line#\'}
	printf '%s' "$line"
}

# The app throws on a bad SITE_GATE and refuses to boot, so checking the same
# combinations here turns a restart-loop into a message, while the running
# container is still untouched. Values are never printed — only their presence
# and their allowed spellings.
check_config() {
	step "Checking $SECRETS_FILE"

	"${PRIV[@]}" test -r "$PG_SECRETS_FILE" || die $E_CONFIG \
		"Cannot read $PG_SECRETS_FILE." \
		"The postgres service loads it via env_file, so the database would come" \
		"up with no credentials the app could match."

	SECRETS_BLOB=$("${PRIV[@]}" cat "$SECRETS_FILE" 2>/dev/null) || die $E_CONFIG \
		"Cannot read $SECRETS_FILE." \
		"compose loads it via env_file, so the container would start without" \
		"any of its configuration. Check the path and the file's ownership."

	local pg_missing=()
	local key
	for key in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB; do
		"${PRIV[@]}" grep -qE "^[[:space:]]*${key}=" "$PG_SECRETS_FILE" 2>/dev/null ||
			pg_missing+=("$key")
	done
	((${#pg_missing[@]} == 0)) || die $E_CONFIG \
		"$PG_SECRETS_FILE is missing: ${pg_missing[*]}." \
		"The database and the app read these from separate files, so a gap here" \
		"starts a database the app cannot authenticate against."

	local mode
	mode=$("${PRIV[@]}" stat -c '%a' "$SECRETS_FILE" 2>/dev/null ||
		"${PRIV[@]}" stat -f '%Lp' "$SECRETS_FILE" 2>/dev/null || echo '')
	if [[ -n $mode && ${mode: -2} != "00" ]]; then
		warn "$SECRETS_FILE is mode $mode on a shared host. 600 is the intent."
	fi

	local missing=()
	for key in ORIGIN PUBLIC_BASE_DOMAIN; do
		[[ -n $(env_value "$key" || true) ]] || missing+=("$key")
	done
	((${#missing[@]} == 0)) || die $E_CONFIG \
		"Required key(s) absent or empty: ${missing[*]}" \
		"ORIGIN missing makes every form action fail with a cross-site error" \
		"while pages keep loading, which is a confusing way to find out."

	local gate
	gate=$(env_value SITE_GATE || true)
	gate=${gate,,}
	case "${gate:-off}" in
		off) GATE_ON=0 ;;
		password)
			GATE_ON=1
			[[ -n $(env_value SITE_GATE_PASSWORD || true) ]] || die $E_CONFIG \
				"SITE_GATE=password but SITE_GATE_PASSWORD is empty or absent." \
				"The app refuses to start on this, so the container would restart-loop."
			;;
		*)
			die $E_CONFIG \
				"SITE_GATE is '${gate}', which is neither 'off' nor 'password'." \
				"The app throws on any other value and will not start."
			;;
	esac

	# The remaining enum the app throws on. A typo is a container that will not
	# boot, so checking it here costs one grep and turns a restart loop into a
	# message.
	local mail
	mail=$(env_value MAIL_TRANSPORT || true)
	mail=${mail,,}
	case "${mail:-smtp}" in
		smtp | mailgun) ;;
		*)
			die $E_CONFIG \
				"MAIL_TRANSPORT is '${mail}', which is neither 'smtp' nor 'mailgun'." \
				"The app throws on any other value and will not start."
			;;
	esac

	local gate_state=off
	((GATE_ON)) && gate_state=on
	say "  gate: ${gate_state}"

	# Core's neutral skin is the compose default, which is right for core on its
	# own and never right for a site that pins it: the build succeeds, boots and
	# serves another community's name. Read from the two files compose reads,
	# because sudo drops anything exported.
	if [[ $LAYOUT == pinned && -z $(env_value SKIN_DIR || true) ]] &&
		! grep -qE '^[[:space:]]*SKIN_DIR=.' "$LOREM_DEPLOY_ROOT/deploy/deploy.env" 2>/dev/null; then
		die $E_CONFIG \
			"SKIN_DIR is not set, so the image would build core's default skin." \
			"Set it in $SECRETS_FILE to the site's skin, relative to $CORE_ROOT" \
			"(.. when the skin sits at the root of the site's repository)."
	fi

	compose config --quiet 2>/dev/null || die $E_CONFIG \
		"docker-compose.yml does not validate." \
		"Run '${DOCKER[*]} compose config' to see why."
}

# Installing the backup units is a manual step (docs/operations.md,
# "Install"), so a host this script deployed can have a running site and no
# backups. A warning rather than a refusal: a deploy is not the moment to block
# on it, but it is the one command every operator runs, so its last word should
# not let anyone believe postgres-data is protected when nothing is dumping it.
check_backup_timer() {
	if ! command -v systemctl >/dev/null 2>&1; then
		warn "No systemctl here, so nothing can say whether a backup timer is installed."
		warn "  Without one postgres-data is never backed up. docs/operations.md, \"Backups\"."
		return 0
	fi
	# Each site copies the example unit pair under its own name, so the name
	# proves nothing: a shared host can run another application's backup timer.
	# A timer counts only when the service it triggers starts this checkout's
	# backup.sh. Read with bash builtins alone, because systemctl is the only
	# command the check can count on finding.
	local want="${CORE_ROOT:-}/deploy/backup.sh" units unit _ svc others=()
	units=$(systemctl list-unit-files --type=timer --no-legend '*-backup.timer' 2>/dev/null) || units=''
	while read -r unit _; do
		[[ -n $unit ]] || continue
		systemctl is-enabled --quiet "$unit" 2>/dev/null || continue
		systemctl is-active --quiet "$unit" 2>/dev/null || continue
		for svc in $(systemctl show -p Triggers --value "$unit" 2>/dev/null); do
			if [[ -n ${CORE_ROOT:-} && $(systemctl show -p ExecStart --value "$svc" 2>/dev/null) == *"path=$want ;"* ]]; then
				say "  backups: $unit runs $want"
				return 0
			fi
		done
		others+=("$unit")
	done <<<"$units"
	if [[ -n ${others[*]:-} ]]; then
		warn "Backup coverage for this deployment cannot be confirmed. Enabled: ${others[*]},"
		warn "  but no enabled timer starts $want."
		warn "  Point a timer's service at it with step 5 of docs/operations.md, \"Install\"."
		return 0
	fi
	warn "No backup timer for this checkout is installed and running: postgres-data is NOT being backed up."
	warn "  Install one with step 5 of docs/operations.md, \"Install\"."
}

# ---------------------------------------------------------------- deploy ----

checkout_target() {
	if [[ $(git rev-parse HEAD) != "$TARGET" ]]; then
		step "Updating work tree"
		mkdir -p "$STATE_DIR"
		# The landed record is kept before the intent replaces it, so a stop
		# before the parent moves leaves the drift it owns explained.
		local landed
		if landed=$(landed_record); then
			printf '%s\n' "$landed" >"$ACCEPTED_FILE.tmp"
			mv -f "$ACCEPTED_FILE.tmp" "$ACCEPTED_FILE"
		else
			rm -f "$ACCEPTED_FILE"
		fi
		printf '%s %s %s %s\n' "$TARGET" "$(core_git rev-parse HEAD)" "$PREDECESSOR" "$(git rev-parse HEAD)" \
			>"$TRANSITION_FILE.tmp"
		mv -f "$TRANSITION_FILE.tmp" "$TRANSITION_FILE"
		if ((ROLLBACK)); then
			git checkout --quiet --detach "$TARGET"
		else
			# --ff-only: a deploy host must never resolve a merge.
			git merge --ff-only --quiet "$TARGET" || die $E_PRECONDITION \
				"Cannot fast-forward to $TARGET." \
				"The checkout has diverged from origin/main. Inspect it by hand;" \
				"a deploy is not the place to reconcile history."
		fi
		[[ $(git rev-parse HEAD) == "$TARGET" ]] || die $E_PRECONDITION \
			"The work tree is at $(git rev-parse --short HEAD), not $(git rev-parse --short "$TARGET")." \
			"Nothing was built or migrated. Inspect the checkout by hand."
		say "  now at $(git rev-parse --short HEAD)"
		record_prior "$PREDECESSOR"
	fi

	sync_core

	# This run is still executing the version parsed before the fast-forward, so
	# any change to the script itself takes effect on the next one. Said here
	# rather than left to be deduced from a failure that looks like the fix did
	# not work. Compared in core against CORE_START, because that commit is what
	# this process is executing; the parent's previous pin can already name the
	# new core when an earlier run stopped between moving the parent and core.
	if ! core_git diff --quiet "$CORE_START" "$(core_git rev-parse HEAD)" -- "$SELF_PATH" 2>/dev/null; then
		warn "$SELF_SHOWN changed in this range. This run is the previous version;" \
			"re-run the deploy afterwards to pick the new one up."
		SELF_CHANGED=1
	fi

	CORE_TAG=$(core_tag_of "$(core_git rev-parse HEAD)")
}

# Written the moment the work tree moves rather than when the deploy succeeds: a
# run that fails after the move has still replaced the predecessor, and
# --rollback is the advice every later failure prints. A run that moves nothing
# (the CI wrapper's second pass, a retry after a failure) never reaches here, so
# it cannot overwrite the release it would roll back to with the one now running.
record_prior() {
	mkdir -p "$STATE_DIR"
	printf '%s\n' "$1" >"$PRIOR_FILE.tmp"
	mv -f "$PRIOR_FILE.tmp" "$PRIOR_FILE"
}

# Run once a deploy is committed to changing things, before anything moves. An
# unfinished move's predecessor goes to prior-commit first, because a retry at
# the same target moves nothing and so would never write it. Then the
# predecessor for this run: HEAD, unless an unfinished move put HEAD there and
# it was never built, in which case the site still runs what that move
# recorded. A rollback steps back from HEAD either way, so a second --rollback
# returns to where the first started.
settle_transition() {
	local unfinished
	if unfinished=$(moved_transition predecessor) && [[ -n $unfinished ]]; then
		record_prior "$unfinished"
		((ROLLBACK)) || {
			PREDECESSOR=$unfinished
			return 0
		}
	fi
	PREDECESSOR=$(git rev-parse HEAD)
}

# The parent moving does not move core: git leaves a submodule where it was
# until told otherwise. Then the result is checked rather than trusted, because
# an `update = none` in the config, or a checkout somebody moved by hand, makes
# the update succeed without changing anything, and the build would then carry
# a core the site's commit never named.
sync_core() {
	[[ $LAYOUT == pinned ]] || {
		clear_transition
		return 0
	}
	git submodule --quiet update --init -- "$CORE_PATH" || die $E_FETCH \
		"git submodule update failed for $CORE_PATH." \
		"Nothing was built. Check this host can read core's origin."
	local want have
	want=$(core_at HEAD)
	have=$(core_git rev-parse HEAD)
	[[ $have == "$want" ]] || die $E_PRECONDITION \
		"$CORE_PATH is at ${have:0:12}, but $(git rev-parse --short HEAD) records ${want:0:12}." \
		"Nothing was built or migrated. Check 'git submodule status' and" \
		"'git config --get submodule.$CORE_PATH.update', then re-run, or run" \
		"--rollback to return both to the release before this one."
	clear_transition
	say "  core at ${want:0:7} ($(core_tag_of "$want"))"
}

run_migrations() {
	((DO_MIGRATE)) || {
		warn "Skipping migrations (--no-migrate)."
		return 0
	}
	step "Migrating"
	# Postgres publishes no port, so the runner has to sit on the compose
	# network; that is what the migrate profile exists for. Non-zero here stops
	# the deploy before the app is replaced.
	#
	# --build is what keeps this honest. `run` reuses whatever image exists, and
	# the `up --build` below rebuilds only the app, so the migrate image can sit
	# at an older commit indefinitely. It then applies the migrations it knows
	# about, reports success, and the app's ensureSchema backstop quietly applies
	# the rest at boot — until the ledger runs ahead of the stale image and its
	# own consistency check fails the deploy. Rebuilding here means the step that
	# gates the deploy is running the code being deployed.
	compose --profile migrate run --build --rm migrate || die $E_MIGRATE \
		"Migration failed. The running container has NOT been replaced." \
		"The site is still serving the older version. Fix the migration" \
		"and run this again; nothing needs undoing." \
		"If the runner named LOREM_WRITERS_STOPPED above, nothing is broken:" \
		"that migration needs the app stopped. See docs/deployment.md, Migrations."
}

start_stack() {
	step "Building"
	# On the command line rather than exported into the environment. The daemon
	# call goes through sudo, and sudo's env_reset drops the variable before
	# compose reads it, so the image gets built with the `unknown` default while
	# every step still reports success. A host whose sudoers keeps more of the
	# environment would have hidden that; an argument cannot be dropped.
	#
	# TARGET is the commit checkout_target just moved to, so the image names the
	# code inside it rather than whatever was current when somebody typed a tag.
	# Pinned, that is the site's commit, and CORE_TAG says which core release
	# came with it.
	compose build --build-arg "LOREM_BUILD_SHA=$TARGET" --build-arg "CORE_TAG=$CORE_TAG" || die $E_START \
		"Build failed." \
		"Nothing was restarted, so the running site is still serving the old" \
		"container. Check '${DOCKER[*]} compose build' for the failing stage."

	# Separate from the build for the reason every other step here is ordered the
	# way it is: a build that fails must not have touched the running site.
	step "Starting"
	compose up -d || die $E_START \
		"Start failed." \
		"The old container may already be gone. Check '${DOCKER[*]} compose ps'" \
		"and '${DOCKER[*]} compose logs --tail 50 ${APP_SERVICE}', then consider --rollback."
}

wait_healthy() {
	step "Waiting for health"
	local waited=0
	until curl -fsS -o /dev/null --max-time 5 "$HEALTH_URL" 2>/dev/null; do
		((waited += 3))
		if ((waited >= HEALTH_TIMEOUT)); then
			compose logs --tail 40 "$APP_SERVICE" >&2 || true
			die $E_VERIFY \
				"No healthy response from $HEALTH_URL after ${HEALTH_TIMEOUT}s." \
				"The last 40 log lines are above. --rollback returns the code," \
				"but not the schema."
		fi
		sleep 3
	done
	say "  healthy after ${waited}s"
}

# A gate that failed open is the failure worth spending a request on: the whole
# reason to turn it on is that strangers do not see the site, and nothing else
# in this script would notice.
verify_gate() {
	((DO_VERIFY)) || {
		warn "Skipping verification (--no-verify)."
		return 0
	}
	step "Verifying"

	# Read from the container rather than from the page: the answer has to hold
	# whether or not the gate is up, and the running process is the authority on
	# which code it is running. A stale image passes every other check here — it
	# is healthy, it serves the right gate state, and it is the previous release.
	local running running_tag
	running=$(compose exec -T "$APP_SERVICE" printenv LOREM_BUILD_SHA 2>/dev/null | tr -d '\r\n' || true)
	running_tag=$(compose exec -T "$APP_SERVICE" printenv CORE_TAG 2>/dev/null | tr -d '\r\n' || true)
	# Both checked, and both reported: an unreadable stamp is a container nothing
	# can vouch for, not one to wave through. An empty CORE_TAG is the expected
	# value for an untagged standalone checkout, so only a difference fails.
	local wrong=()
	if [[ -z $running ]]; then
		wrong+=("The running container reports no LOREM_BUILD_SHA; expected ${TARGET:0:7}.")
	elif [[ $running != "$TARGET" ]]; then
		wrong+=("The running container was built from ${running:0:7}, not ${TARGET:0:7}.")
	fi
	[[ $running_tag == "$CORE_TAG" ]] ||
		wrong+=("The running container reports core '${running_tag}', not '${CORE_TAG}'.")
	((${#wrong[@]} == 0)) || die $E_VERIFY "${wrong[@]}" \
		"The build was served from cache, the restart did not take, or the image" \
		"was built without this deploy's stamps. Re-run, and if it repeats check" \
		"'${DOCKER[*]} compose images ${APP_SERVICE}'."
	say "  running ${TARGET:0:7}${CORE_TAG:+, core $CORE_TAG}"

	local body
	body=$(curl -fsS --max-time 10 "$SITE_URL" 2>/dev/null) || die $E_VERIFY \
		"$SITE_URL did not return a successful response." \
		"Check '${DOCKER[*]} compose logs --tail 50 ${APP_SERVICE}'."

	if ((GATE_ON)); then
		[[ $body == *'name="gate-password"'* ]] || die $E_VERIFY \
			"SITE_GATE=password, but the site served a page instead of the gate." \
			"The site is publicly readable right now. Check that the container" \
			"picked up the secrets file: '${DOCKER[*]} compose config | grep -i site_gate'."
		say "  gate is up: / serves the password form"
	else
		[[ $body != *'name="gate-password"'* ]] || die $E_VERIFY \
			"SITE_GATE is off, but the site is serving the gate." \
			"Members are locked out. Check the secrets file and restart."
		say "  gate is off: / serves the site"
	fi

	curl -fsS -o /dev/null --max-time 5 "$HEALTH_URL" || die $E_VERIFY \
		"/healthz stopped answering after the gate check."
	say "  /healthz answers"
}

# ------------------------------------------------------------------ main ----

preflight
((ROLLBACK)) || fetch_origin
resolve_target
check_core_pin
show_plan
check_config

if ((DRY_RUN)); then
	step "Dry run"
	check_backup_timer
	say "  Nothing was changed. Drop --dry-run to deploy."
	exit 0
fi

if ! confirm "Deploy $(git rev-parse --short "$TARGET")?"; then
	say "Aborted. Nothing was changed."
	exit 0
fi

settle_transition
checkout_target
run_migrations
start_stack
wait_healthy
verify_gate

step "Deployed"
say "  $(git rev-parse --short HEAD)${CORE_TAG:+, core $CORE_TAG}"
check_backup_timer
((SELF_CHANGED)) && say "  ${C_YELLOW}re-run $SELF_SHOWN: it updated itself this run${C_OFF}"
say "  ${C_DIM}roll the code back with: $SELF_SHOWN --rollback${C_OFF}"
