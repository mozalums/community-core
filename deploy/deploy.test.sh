#!/usr/bin/env bash
#
# Drives deploy/deploy.sh through both layouts against real git repositories in
# a scratch directory, with docker and curl stubbed. Git is the part worth not
# stubbing: every decision the layout changes is a question asked of git
# (which repository is the superproject, which core commit a site commit
# records, what a tag points at, whether a submodule moved), and a stub would
# answer whatever the test assumed.
#
# Each fixture: a core origin with tagged releases, a site origin that pins core
# as a submodule at `core`, and a host clone of each (pinned and standalone).

set -uo pipefail

HERE=$(cd -- "${BASH_SOURCE[0]%/*}" && pwd) || exit 1
readonly HERE SUT="$HERE/deploy.sh"

pass=0 fail=0

# Nothing from the user's git config reaches the fixtures: a global hook, a
# signing key or a default branch name would change what the repositories hold.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
# Submodules over a local path are refused by default since git 2.38.1.
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=protocol.file.allow GIT_CONFIG_VALUE_0=always
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.org
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.org
export NO_COLOR=1 LOREM_HEALTH_TIMEOUT=3

ok() {
	printf 'ok   %s\n' "$1"
	pass=$((pass + 1))
}
bad() {
	printf 'FAIL %s\n' "$1"
	shift
	for line in "$@"; do printf '       %s\n' "$line"; done
	fail=$((fail + 1))
}

g() { git -C "$@"; }

commit_core() {
	local msg=$1 tag=${2:-}
	g "$T/core-src" add -A
	g "$T/core-src" commit --quiet -m "$msg"
	[[ -z $tag ]] || g "$T/core-src" tag "$tag"
	g "$T/core-src" push --quiet --tags origin main
}

pin() {
	local ref=$1
	g "$T/site-src/core" fetch --quiet --tags origin
	g "$T/site-src/core" checkout --quiet "$ref"
	g "$T/site-src" add core
	g "$T/site-src" commit --quiet -m "pin core at $ref"
	g "$T/site-src" push --quiet origin main
}

stubs() {
	mkdir -p "$T/bin"
	# A build records the two values it was given; exec answers with them, as a
	# container built from that image would, unless STUB_CORE_TAG overrides.
	cat >"$T/bin/docker" <<STUB
#!/usr/bin/env bash
echo "docker \$*" >>"$T/docker.log"
[[ \$1 == compose ]] || exit 0
args=" \$* "
case "\$args" in
	*" build "*)
		pwd -P >>"$T/compose-cwd"
		for a in "\$@"; do
			case "\$a" in
				LOREM_BUILD_SHA=*) printf '%s' "\${a#*=}" >"$T/built-sha" ;;
				CORE_TAG=*) printf '%s' "\${a#*=}" >"$T/built-tag" ;;
			esac
		done
		;;
	*" printenv LOREM_BUILD_SHA "*) cat "$T/built-sha" ;;
	*" printenv CORE_TAG "*)
		if [[ -n \${STUB_CORE_TAG:-} ]]; then echo "\$STUB_CORE_TAG"; else cat "$T/built-tag"; fi
		;;
esac
exit 0
STUB
	cat >"$T/bin/curl" <<'STUB'
#!/usr/bin/env bash
[[ " $* " == *healthz* ]] || echo '<html>directory</html>'
exit 0
STUB
	chmod +x "$T/bin/docker" "$T/bin/curl"
}

fixture() {
	T=$(mktemp -d)
	stubs

	mkdir -p "$T/secrets"
	printf 'ORIGIN=https://www.example.org\nPUBLIC_BASE_DOMAIN=example.org\nSKIN_DIR=..\n' >"$T/secrets/.env"
	printf 'POSTGRES_USER=u\nPOSTGRES_PASSWORD=p\nPOSTGRES_DB=d\n' >"$T/secrets/postgres.env"
	chmod 600 "$T/secrets/.env" "$T/secrets/postgres.env"

	git init --quiet --bare -b main "$T/core.git"
	git init --quiet -b main "$T/core-src"
	g "$T/core-src" remote add origin "$T/core.git"
	mkdir -p "$T/core-src/deploy" "$T/core-src/src/lib/server"
	cp "$SUT" "$T/core-src/deploy/deploy.sh"
	echo 'services: {}' >"$T/core-src/docker-compose.yml"
	echo 'export const one = 1;' >"$T/core-src/src/lib/server/migrations.ts"
	commit_core 'core one' v0.1.0
	echo 'notes' >"$T/core-src/NOTES"
	commit_core 'core notes' v0.1.1
	echo '# a later revision' >>"$T/core-src/deploy/deploy.sh"
	commit_core 'core script' v0.2.0
	echo 'export const two = 2;' >>"$T/core-src/src/lib/server/migrations.ts"
	commit_core 'core migration' v0.3.0
	echo 'more' >>"$T/core-src/NOTES"
	commit_core 'core between releases'

	git init --quiet --bare -b main "$T/site.git"
	git init --quiet -b main "$T/site-src"
	g "$T/site-src" remote add origin "$T/site.git"
	g "$T/site-src" submodule --quiet add "$T/core.git" core
	g "$T/site-src/core" checkout --quiet v0.1.0
	echo 'id: site' >"$T/site-src/skin.yaml"
	g "$T/site-src" add -A
	g "$T/site-src" commit --quiet -m 'site one'
	g "$T/site-src" push --quiet origin main

	git clone --quiet --recurse-submodules "$T/site.git" "$T/host" 2>/dev/null
	git clone --quiet "$T/core.git" "$T/alone"
	: >"$T/docker.log"
}

# No TTY on stdin, as under CI's forced command, so the run never prompts.
deploy() {
	local root=$1
	shift
	PATH="$T/bin:$PATH" LOREM_SECRETS_DIR="$T/secrets" \
		"$root/deploy/deploy.sh" "$@" </dev/null >"$T/out" 2>&1
	rc=$?
}
pinned() { deploy "$T/host/core" "$@"; }
standalone() { deploy "$T/alone" "$@"; }

out_has() { grep -qF -- "$1" "$T/out"; }
sha() { git -C "$1" rev-parse "${2:-HEAD}"; }
cleanup() { rm -rf "$T"; }

# ----------------------------------------------------------------- layout ----

fixture
pinned --dry-run
if ((rc == 0)) && out_has "layout: pinned, deploying $(cd "$T/host" && pwd -P) with core at core"; then
	ok 'layout: a submodule checkout deploys its superproject'
else
	bad 'layout: a submodule checkout deploys its superproject' "rc=$rc" "$(cat "$T/out")"
fi
standalone --dry-run
if ((rc == 0)) && out_has "layout: standalone, deploying $T/alone"; then
	ok 'layout: a checkout with no superproject deploys itself'
else
	bad 'layout: a checkout with no superproject deploys itself' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

# ------------------------------------------------------- a full pinned run ----

fixture
pin v0.1.1
pinned
want_sha=$(sha "$T/site.git" main)
if ((rc == 0)) && [[ $(sha "$T/host") == "$want_sha" && $(sha "$T/host/core") == $(sha "$T/core.git" v0.1.1) ]] &&
	[[ $(cat "$T/built-sha") == "$want_sha" && $(cat "$T/built-tag") == v0.1.1 ]] &&
	out_has "running ${want_sha:0:7}, core v0.1.1" &&
	[[ $(sort -u "$T/compose-cwd") == $(cd "$T/host/core" && pwd -P) ]]; then
	ok 'pinned: the site and core both move, and the build is stamped with both'
else
	bad 'pinned: the site and core both move, and the build is stamped with both' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

fixture
pin v0.1.1
STUB_CORE_TAG=v0.1.0 pinned
if ((rc == 7)) && out_has "reports core 'v0.1.0', not 'v0.1.1'"; then
	ok 'verify: a container reporting another core tag fails the deploy'
else
	bad 'verify: a container reporting another core tag fails the deploy' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

fixture
sed -i.bak '/^SKIN_DIR=/d' "$T/secrets/.env"
pinned --dry-run
if ((rc == 4)) && out_has 'SKIN_DIR is not set'; then
	ok "config: a pinned deploy with no SKIN_DIR is refused before the build"
else
	bad "config: a pinned deploy with no SKIN_DIR is refused before the build" "rc=$rc" "$(cat "$T/out")"
fi
cleanup

# ------------------------------------------------------- submodule refusals ----

fixture
pin v0.1.1
git -C "$T/host" config submodule.core.update none
pinned
if ((rc == 2)) && out_has "core is at $(sha "$T/core.git" v0.1.0 | cut -c1-12), but" &&
	! grep -qE ' (build|run) ' "$T/docker.log"; then
	ok 'submodule: core left behind by the update stops the deploy before any build'
else
	bad 'submodule: core left behind by the update stops the deploy before any build' "rc=$rc" "$(cat "$T/out")" "$(cat "$T/docker.log")"
fi
cleanup

# ------------------------------------------------ interrupted transitions ----

# The host the mismatch stop leaves behind: the parent at the new pin, core at
# the old one, and update = none unset so the next run is able to sync.
stopped_sync() {
	fixture
	first=$(sha "$T/host")
	first_core=$(sha "$T/host/core")
	pin v0.2.0
	g "$T/host" config submodule.core.update none
	pinned
	stop_rc=$rc
	g "$T/host" config --unset submodule.core.update
}

stopped_sync
pinned
retry_rc=$rc
left=$([[ -e $T/host/.git/lorem-deploy/core-transition ]] && echo yes || echo no)
pinned --rollback
if ((stop_rc == 2 && retry_rc == 0 && rc == 0)) && [[ $left == no ]] &&
	[[ $(sha "$T/host") == "$first" && $(sha "$T/host/core") == "$first_core" ]]; then
	ok 'transition: a re-run finishes a stopped sync, and rollback still reaches the release before it'
else
	bad 'transition: a re-run finishes a stopped sync, and rollback still reaches the release before it' \
		"stop rc=$stop_rc, retry rc=$retry_rc, rollback rc=$rc, marker left=$left" "$(cat "$T/out")"
fi
cleanup

stopped_sync
pin v0.3.0
pinned
forward_rc=$rc
pinned --rollback
if ((stop_rc == 2 && forward_rc == 0 && rc == 0)) &&
	[[ $(sha "$T/host") == "$first" && $(sha "$T/host/core") == "$first_core" ]]; then
	ok 'transition: deploying past a stopped sync keeps the release that was running as the predecessor'
else
	bad 'transition: deploying past a stopped sync keeps the release that was running as the predecessor' \
		"stop rc=$stop_rc, forward rc=$forward_rc, rollback rc=$rc" "$(cat "$T/out")"
fi
cleanup

stopped_sync
echo 'edited on the host' >>"$T/host/skin.yaml"
pinned --rollback
if ((rc == 2)) && out_has 'uncommitted changes'; then
	ok 'transition: a file edit beside the gitlink drift is still a dirty tree'
else
	bad 'transition: a file edit beside the gitlink drift is still a dirty tree' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

stopped_sync
echo 'edited inside core' >>"$T/host/core/NOTES"
pinned --rollback
if ((rc == 2)) && out_has 'uncommitted changes'; then
	ok 'transition: an edit inside core is still a dirty tree'
else
	bad 'transition: an edit inside core is still a dirty tree' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

stopped_sync
g "$T/host/core" checkout --quiet v0.1.1
pinned --rollback
if ((rc == 2)) && out_has 'uncommitted changes'; then
	ok 'transition: core moved by hand to a third commit is not the recorded drift'
else
	bad 'transition: core moved by hand to a third commit is not the recorded drift' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

stopped_sync
g "$T/host" add core
pinned --rollback
if ((rc == 2)) && out_has 'uncommitted changes'; then
	ok 'transition: a staged gitlink is an operator edit, not the recorded drift'
else
	bad 'transition: a staged gitlink is an operator edit, not the recorded drift' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

# A resume starts from the core commit the stopped run left checked out, so the
# migration range and the script comparison run from there, and the pass after
# it, already running the new script, has nothing left to report.
stopped_sync
pin v0.3.0
g "$T/host" config submodule.core.update none
pinned
g "$T/host" config --unset submodule.core.update
pinned
resume_warned=no
out_has 'migrations.ts changes in this range' && out_has 'core/deploy/deploy.sh changed in this range' && resume_warned=yes
resume_rc=$rc
pinned
if ((stop_rc == 2 && resume_rc == 0 && rc == 0)) && [[ $resume_warned == yes ]] &&
	! out_has 'changed in this range' && ! out_has 'migrations.ts changes'; then
	ok 'transition: a resume warns for the core range it performs, and the next pass is quiet'
else
	bad 'transition: a resume warns for the core range it performs, and the next pass is quiet' \
		"stop rc=$stop_rc, resume rc=$resume_rc, warned=$resume_warned, next rc=$rc" "$(cat "$T/out")"
fi
cleanup

# Each setting below hides a real edit from a plain `git status`.
hidden_edit() {
	local label=$1 key=$2 value=$3 where=$4
	fixture
	pin v0.1.1
	g "$T/host" config "$key" "$value"
	echo 'host edit' >>"$T/host/$where"
	pinned
	if ((rc == 2)) && out_has 'uncommitted changes' && ! grep -qE ' (build|run) ' "$T/docker.log"; then
		ok "dirty: $label"
	else
		bad "dirty: $label" "rc=$rc" "$(cat "$T/out")"
	fi
	cleanup
}
hidden_edit 'an edit inside core is refused under diff.ignoreSubmodules=all' \
	diff.ignoreSubmodules all core/src/lib/server/migrations.ts
hidden_edit 'an edit inside core is refused under submodule.core.ignore=all' \
	submodule.core.ignore all core/NOTES
hidden_edit 'an untracked file in the site is refused under status.showUntrackedFiles=no' \
	status.showUntrackedFiles no UNTRACKED

stopped_sync
g "$T/host" config status.showUntrackedFiles no
echo 'planted' >"$T/host/UNTRACKED"
pinned --rollback
if ((rc == 2)) && out_has 'uncommitted changes'; then
	ok 'transition: an untracked file hidden by config is not the recorded drift'
else
	bad 'transition: an untracked file hidden by config is not the recorded drift' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

fixture
pin v0.1.1
g "$T/host" update-index --assume-unchanged skin.yaml
echo 'host edit' >>"$T/host/skin.yaml"
pinned
if ((rc == 2)) && out_has 'skin.yaml' && out_has 'assume-unchanged or skip-worktree' &&
	[[ $(g "$T/host" ls-files -v skin.yaml) == 'h skin.yaml' ]] && ! grep -qE ' (build|run) ' "$T/docker.log"; then
	ok 'dirty: a site file git is told not to check is refused, and its index bit left alone'
else
	bad 'dirty: a site file git is told not to check is refused, and its index bit left alone' \
		"rc=$rc, entry=$(g "$T/host" ls-files -v skin.yaml)" "$(cat "$T/out")"
fi
cleanup

# SIGTERM to the deploy the moment the real fast-forward returns: the parent
# has moved and nothing after the merge has run.
kill_after_merge() {
	REAL_GIT=$(command -v git)
	export REAL_GIT
	cat >"$T/bin/git" <<'STUB'
#!/usr/bin/env bash
if [[ $1 == merge ]]; then
	"$REAL_GIT" "$@" || exit $?
	kill -TERM "$PPID"
	exit 0
fi
exec "$REAL_GIT" "$@"
STUB
	chmod +x "$T/bin/git"
}

fixture
pin v0.1.1
pinned
running=$(sha "$T/host")
running_core=$(sha "$T/host/core")
pin v0.2.0
kill_after_merge
pinned
stop_rc=$rc
rm "$T/bin/git"
pin v0.3.0
pinned
forward_rc=$rc
pinned --rollback
if ((stop_rc == 130 && forward_rc == 0 && rc == 0)) &&
	[[ $(sha "$T/host") == "$running" && $(sha "$T/host/core") == "$running_core" ]]; then
	ok 'transition: advancing past a move the interrupt cut short keeps the running release as predecessor'
else
	bad 'transition: advancing past a move the interrupt cut short keeps the running release as predecessor' \
		"stop rc=$stop_rc, forward rc=$forward_rc, rollback rc=$rc" "$(cat "$T/out")"
fi
cleanup

kill_before_move() {
	cat >"$T/bin/git" <<'STUB'
#!/usr/bin/env bash
if [[ $1 == merge || $1 == checkout ]]; then
	kill -TERM "$PPID"
	exit 0
fi
exec "$REAL_GIT" "$@"
STUB
	chmod +x "$T/bin/git"
}

fixture
running=$(sha "$T/host")
running_core=$(sha "$T/host/core")
pin v0.2.0
g "$T/host" config submodule.core.update none
pinned
stop_rc=$rc
g "$T/host" config --unset submodule.core.update
stopped=$(sha "$T/host")
pin v0.3.0
kill_before_move
pinned
first_rc=$rc
pinned
second_rc=$rc
rm "$T/bin/git"
held=$([[ $(sha "$T/host") == "$stopped" && $(sha "$T/host/core") == "$running_core" ]] && echo yes || echo no)
pinned
forward_rc=$rc
forward_core=$(sha "$T/host/core")
pinned --rollback
if ((stop_rc == 2 && first_rc == 130 && second_rc == 130 && forward_rc == 0 && rc == 0)) && [[ $held == yes &&
	$forward_core == $(sha "$T/core.git" v0.3.0) && $(sha "$T/host") == "$running" && $(sha "$T/host/core") == "$running_core" ]]; then
	ok 'transition: repeated interrupts before the move keep the stopped sync recoverable and its predecessor'
else
	bad 'transition: repeated interrupts before the move keep the stopped sync recoverable and its predecessor' \
		"stop rc=$stop_rc, interrupts rc=$first_rc/$second_rc, held=$held, forward rc=$forward_rc, rollback rc=$rc" "$(cat "$T/out")"
fi
cleanup

fixture
g "$T/alone" reset --quiet --hard v0.1.1
running=$(sha "$T/alone")
kill_after_merge
standalone
stop_rc=$rc
rm "$T/bin/git"
moved=$(sha "$T/alone")
standalone --rollback
if ((stop_rc == 130 && rc == 0)) && [[ $moved != "$running" && $(sha "$T/alone") == "$running" ]]; then
	ok 'transition: standalone, rollback after an interrupt past the move returns to the release before it'
else
	bad 'transition: standalone, rollback after an interrupt past the move returns to the release before it' \
		"stop rc=$stop_rc, rollback rc=$rc, moved=$moved" "$(cat "$T/out")"
fi
cleanup

fixture
loose=$(sha "$T/core.git" main)
pin "$loose"
before=$(sha "$T/host")
pinned
if ((rc == 2)) && out_has "Core is pinned at ${loose:0:12}, which is not a release tag (nearest: v0.3.0)" &&
	[[ $(sha "$T/host") == "$before" ]] && ! grep -qE ' (build|run) ' "$T/docker.log"; then
	ok 'tag: an untagged core is refused, naming the commit and the nearest tag, before anything moves'
else
	bad 'tag: an untagged core is refused, naming the commit and the nearest tag, before anything moves' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

# --------------------------------------------------------- migration diff ----

fixture
pin v0.2.0
pinned
pin v0.3.0
pinned --dry-run
if ((rc == 0)) && out_has 'migrations.ts changes in this range'; then
	ok 'migrations, pinned: a pointer move that changes core migrations.ts warns'
else
	bad 'migrations, pinned: a pointer move that changes core migrations.ts warns' "rc=$rc" "$(cat "$T/out")"
fi
pinned
mkdir -p "$T/site-src/src/lib/server"
echo 'site file' >"$T/site-src/src/lib/server/migrations.ts"
g "$T/site-src" add -A
g "$T/site-src" commit --quiet -m 'site file at the path core uses'
g "$T/site-src" push --quiet origin main
pinned --dry-run
if ((rc == 0)) && ! out_has 'migrations.ts changes'; then
	ok "migrations, pinned: the site's own file at that path is not core's schema"
else
	bad "migrations, pinned: the site's own file at that path is not core's schema" "rc=$rc" "$(cat "$T/out")"
fi
cleanup

fixture
g "$T/alone" reset --quiet --hard v0.2.0
standalone --dry-run
if ((rc == 0)) && out_has 'migrations.ts changes in this range'; then
	ok 'migrations, standalone: a range that changes migrations.ts warns'
else
	bad 'migrations, standalone: a range that changes migrations.ts warns' "rc=$rc" "$(cat "$T/out")"
fi
g "$T/alone" reset --quiet --hard v0.3.0
standalone --dry-run
if ((rc == 0)) && ! out_has 'migrations.ts changes'; then
	ok 'migrations, standalone: a range that leaves it alone is quiet'
else
	bad 'migrations, standalone: a range that leaves it alone is quiet' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

# ------------------------------------------------------------ self-update ----

fixture
pin v0.1.1
pinned
if ((rc == 0)) && ! out_has 'changed in this range'; then
	ok 'self-update: a pointer move that leaves deploy.sh alone is quiet'
else
	bad 'self-update: a pointer move that leaves deploy.sh alone is quiet' "rc=$rc" "$(cat "$T/out")"
fi
pin v0.2.0
pinned
if ((rc == 0)) && out_has 'core/deploy/deploy.sh changed in this range' && out_has 're-run core/deploy/deploy.sh'; then
	ok 'self-update: a pointer move that changes deploy.sh warns'
else
	bad 'self-update: a pointer move that changes deploy.sh warns' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

# --------------------------------------------------------------- rollback ----

fixture
first=$(sha "$T/host")
first_core=$(sha "$T/host/core")
pin v0.2.0
pinned
moved=$(sha "$T/host/core")
pinned --rollback
if ((rc == 0)) && [[ $(sha "$T/host") == "$first" && $(sha "$T/host/core") == "$first_core" && $moved != "$first_core" ]] &&
	[[ $(cat "$T/built-tag") == v0.1.0 ]]; then
	ok 'rollback: the site and its core return together'
else
	bad 'rollback: the site and its core return together' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

fixture
first=$(sha "$T/host")
first_core=$(sha "$T/host/core")
pin v0.1.1
STUB_CORE_TAG=v9.9.9 pinned
failed_rc=$rc
pinned
retry_rc=$rc
pinned --rollback
if ((failed_rc == 7 && retry_rc == 0 && rc == 0)) &&
	[[ $(sha "$T/host") == "$first" && $(sha "$T/host/core") == "$first_core" ]]; then
	ok 'rollback: a failed pass that moved, then a retry that did not, still returns to the old release'
else
	bad 'rollback: a failed pass that moved, then a retry that did not, still returns to the old release' \
		"failed rc=$failed_rc, retry rc=$retry_rc, rollback rc=$rc" "$(cat "$T/out")"
fi
cleanup

# ------------------------------------------------- the tree that builds ----

fixture
echo 'local' >"$T/alone/LOCAL"
g "$T/alone" add LOCAL
g "$T/alone" commit --quiet -m 'local commit'
before=$(sha "$T/alone")
standalone
if ((rc == 2)) && out_has 'is not an ancestor of origin/main' && [[ $(sha "$T/alone") == "$before" ]] &&
	! grep -qE ' (build|run) ' "$T/docker.log"; then
	ok 'target, standalone: a checkout ahead of origin/main is refused before anything builds'
else
	bad 'target, standalone: a checkout ahead of origin/main is refused before anything builds' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

fixture
before=$(sha "$T/alone")
standalone --ref v0.1.0
if ((rc == 2)) && out_has 'is not an ancestor of v0.1.0' && [[ $(sha "$T/alone") == "$before" ]] &&
	! grep -qE ' (build|run) ' "$T/docker.log"; then
	ok 'target: a --ref behind the checkout is refused, not built under its stamp'
else
	bad 'target: a --ref behind the checkout is refused, not built under its stamp' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

fixture
standalone
if ((rc == 0)) && [[ $(cat "$T/built-sha") == $(sha "$T/core.git" main) && -z $(cat "$T/built-tag") ]] &&
	out_has "running $(sha "$T/core.git" main | cut -c1-7)"; then
	ok 'verify, standalone: an untagged checkout deploys with an empty core tag'
else
	bad 'verify, standalone: an untagged checkout deploys with an empty core tag' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

fixture
pin v0.1.1
sed -i.bak 's@cat "\(.*\)/built-sha" ;;@exit 1 ;;@' "$T/bin/docker"
pinned
if ((rc == 7)) && out_has 'reports no LOREM_BUILD_SHA' && ! out_has "reports core"; then
	ok 'verify: a missing build stamp fails the deploy even when the core tag matches'
else
	bad 'verify: a missing build stamp fails the deploy even when the core tag matches' "rc=$rc" "$(cat "$T/out")"
fi
pinned --no-verify
if ((rc == 0)) && out_has 'Skipping verification'; then
	ok 'verify: --no-verify still skips the stamp checks'
else
	bad 'verify: --no-verify still skips the stamp checks' "rc=$rc" "$(cat "$T/out")"
fi
cleanup

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
