#!/usr/bin/env bash
#
# Prepares a host to run deploy/deploy.sh, which refuses to start until the
# secrets files exist and compose can read them. Everything below is what stood
# between a fresh clone and a first deploy, written down as code because prose
# is where the two-file credential split gets fumbled.
#
# It does not clone. Both repositories are private, so the credential has to
# exist before the checkout does, which puts the clone ahead of any script that
# lives inside it. docs/deployment.md, "First install", covers that half.
#
# Safe to re-run: an existing secrets file is never rewritten, because the one
# on the host is the only copy of values nothing else stores.
#
# Exit codes: 1 usage, 2 precondition, 3 config.

set -euo pipefail

readonly E_USAGE=1 E_PRECONDITION=2 E_CONFIG=3

# Resolved with parameter expansion rather than dirname(1). A PATH too broken to
# find coreutils makes the substitution empty, which silently resolves the repo
# root to / and turns every check below into a confusing answer about the wrong
# directory. This form cannot fail that way.
_self=${BASH_SOURCE[0]}
_dir=${_self%/*}
[[ $_dir == "$_self" ]] && _dir=.
REPO_ROOT=$(cd -- "$_dir/.." && pwd)
readonly REPO_ROOT
unset _self _dir
cd "$REPO_ROOT"

# Read on the same terms deploy.sh reads it, so a host that has already chosen
# its paths does not have to repeat them here.
if [[ -f "$REPO_ROOT/deploy/deploy.env" ]]; then
	set -a
	# shellcheck disable=SC1091
	. "$REPO_ROOT/deploy/deploy.env"
	set +a
fi

readonly SECRETS_DIR=${LOREM_SECRETS_DIR:-/data/secrets/lorem-host}
readonly APP_ENV=$SECRETS_DIR/.env
readonly PG_ENV=$SECRETS_DIR/postgres.env
readonly STAGING=${LOREM_BACKUP_DIR:-/var/backups/lorem-host}

DRY_RUN=0
ORIGIN_ARG=''
ENV_TEMPLATE=.env.example

if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
	C_BOLD=$'\033[1m' C_YELLOW=$'\033[33m' C_RED=$'\033[31m' C_OFF=$'\033[0m'
else
	C_BOLD='' C_YELLOW='' C_RED='' C_OFF=''
fi
readonly C_BOLD C_YELLOW C_RED C_OFF

say() { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$C_BOLD" "$*" "$C_OFF"; }
warn() { printf '%swarning:%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }

die() {
	local code=$1
	shift
	printf '%serror:%s %s\n' "$C_RED" "$C_OFF" "$1" >&2
	shift
	local line
	for line in "$@"; do printf '       %s\n' "$line" >&2; done
	exit "$code"
}

usage() {
	cat <<EOF
Prepare this host for deploy/deploy.sh.

Usage: deploy/bootstrap.sh [options]

  --origin URL   Site origin, e.g. https://www.example.com. Also sets
                 PUBLIC_BASE_DOMAIN to the apex, which is what the session
                 cookie scopes to. See docs/configuration.md.
  --env-example FILE
                 Seed .env from FILE instead of .env.example, e.g. a
                 community's own template under skin/<name>/deploy/. A
                 relative path is read from the checkout root.
  --dry-run      Report what would be created; write nothing.
  -h, --help     This.

Creates $SECRETS_DIR with postgres.env (generated credentials) and .env
(from the template), then names every value still needing a human. Never
rewrites a secrets file that already exists.
EOF
}

while (($#)); do
	case $1 in
		--origin)
			[[ ${2:-} ]] || die $E_USAGE "--origin needs a URL, e.g. https://www.example.com."
			ORIGIN_ARG=$2
			shift 2
			;;
		--env-example)
			[[ ${2:-} ]] || die $E_USAGE "--env-example needs a file, e.g. skin/<name>/deploy/env.example."
			ENV_TEMPLATE=$2
			shift 2
			;;
		--dry-run)
			DRY_RUN=1
			shift
			;;
		-h | --help)
			usage
			exit 0
			;;
		*) die $E_USAGE "Unknown argument: $1" "Run with --help." ;;
	esac
done

# --------------------------------------------------------------- helpers ----

# Hex rather than base64: the value is pasted into two env files and read back by
# a shell and by pg, and neither should have to think about quoting.
gen_secret() {
	if command -v openssl >/dev/null 2>&1; then
		openssl rand -hex 24
	else
		# `head -c` closes the pipe, which is a failure under pipefail and is not
		# one here.
		(
			set +o pipefail
			LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48
			echo
		)
	fi
}

# Strips the scheme and a leading `www.`, because the cookie is scoped to the
# apex and a value carrying `www.` locks members out of the bare domain.
apex_of() {
	local host=${1#http://}
	host=${host#https://}
	host=${host%%/*}
	printf '%s\n' "${host#www.}"
}

set_key() {
	local file=$1 key=$2 value=$3
	sudo sed -i -E "s|^[[:space:]]*#?[[:space:]]*${key}=.*|${key}=${value}|" "$file"
}

# --------------------------------------------------------------- checks -----

step "Preflight"

[[ $EUID -ne 0 ]] || die $E_PRECONDITION \
	"Do not run this as root." \
	"It borrows sudo for the two paths that need it and leaves the checkout" \
	"owned by you, the same split deploy/deploy.sh makes."

missing=()
for cmd in git docker curl sudo sed; do
	command -v "$cmd" >/dev/null 2>&1 || missing+=("$cmd")
done
((${#missing[@]} == 0)) || die $E_PRECONDITION \
	"Not on PATH: ${missing[*]}." \
	"Install them and run this again."

docker compose version >/dev/null 2>&1 || die $E_PRECONDITION \
	"'docker compose' is not available." \
	"This needs the Compose v2 plugin; the v1 'docker-compose' binary is not a" \
	"substitute, because the deploy uses profiles."

sudo -v || die $E_PRECONDITION "sudo is required and was refused."

# Relative to the checkout, which the script has already cd'd into, so the
# same argument works from any directory.
[[ $ENV_TEMPLATE == /* ]] || ENV_TEMPLATE=$REPO_ROOT/$ENV_TEMPLATE
readonly ENV_TEMPLATE
[[ -f $ENV_TEMPLATE ]] || die $E_CONFIG \
	"No env template at $ENV_TEMPLATE." \
	"It scaffolds the app's secrets file. Run from a checkout, and check the" \
	"path given to --env-example if you gave one."

say "  ok: git, docker, compose v2, curl, sudo"
say "  secrets dir: $SECRETS_DIR"
say "  env template: $ENV_TEMPLATE"
((DRY_RUN)) && say "  dry run: nothing below is written"

# ---------------------------------------------------------------- create ----

step "Secrets directory"

if sudo test -d "$SECRETS_DIR"; then
	say "  exists: $SECRETS_DIR"
elif ((DRY_RUN)); then
	say "  would create $SECRETS_DIR (0750 root:root)"
else
	sudo install -d -m 750 -o root -g root "$SECRETS_DIR"
	say "  created $SECRETS_DIR (0750 root:root)"
fi

step "Database credentials"

PG_USER=lorem
PG_DB=lorem
PG_PASS=''

if sudo test -f "$PG_ENV"; then
	say "  exists: $PG_ENV — left alone"
	say "  ${C_BOLD}The app's .env must carry the same three values${C_OFF}, spelled"
	say "  POSTGRES_DATABASE there and POSTGRES_DB here. deploy.sh checks that"
	say "  this file has all three; nothing checks that the two files agree."
elif ((DRY_RUN)); then
	say "  would create $PG_ENV (0600 root:root) with a generated password"
else
	PG_PASS=$(gen_secret)
	# Written through a heredoc rather than an argument: a password on a command
	# line is readable in ps by every other user on the box.
	sudo install -m 600 -o root -g root /dev/null "$PG_ENV"
	sudo tee "$PG_ENV" >/dev/null <<EOF
POSTGRES_USER=$PG_USER
POSTGRES_PASSWORD=$PG_PASS
POSTGRES_DB=$PG_DB
EOF
	say "  created $PG_ENV (0600 root:root), password generated"
fi

step "Application secrets"

if sudo test -f "$APP_ENV"; then
	say "  exists: $APP_ENV — left alone"
elif ((DRY_RUN)); then
	say "  would create $APP_ENV from $ENV_TEMPLATE (0600 root:root)"
else
	sudo install -m 600 -o root -g root /dev/null "$APP_ENV"
	sudo tee "$APP_ENV" >/dev/null <"$ENV_TEMPLATE"

	if [[ -n $PG_PASS ]]; then
		set_key "$APP_ENV" POSTGRES_USER "$PG_USER"
		set_key "$APP_ENV" POSTGRES_PASSWORD "$PG_PASS"
		# The container spells it POSTGRES_DB and the app spells it
		# POSTGRES_DATABASE. Same value, and the only place that is written down
		# in code rather than in a comment.
		set_key "$APP_ENV" POSTGRES_DATABASE "$PG_DB"
		say "  database credentials match $PG_ENV"
	else
		warn "$PG_ENV already existed, so the database credentials in $APP_ENV"
		warn "still carry the template's placeholders. Copy the three values across."
	fi

	if [[ -n $ORIGIN_ARG ]]; then
		set_key "$APP_ENV" ORIGIN "$ORIGIN_ARG"
		set_key "$APP_ENV" PUBLIC_BASE_DOMAIN "$(apex_of "$ORIGIN_ARG")"
		say "  ORIGIN=$ORIGIN_ARG, PUBLIC_BASE_DOMAIN=$(apex_of "$ORIGIN_ARG")"
	fi

	say "  created $APP_ENV (0600 root:root) from $ENV_TEMPLATE"
fi

step "Backup staging"

if sudo test -d "$STAGING"; then
	say "  exists: $STAGING"
elif ((DRY_RUN)); then
	say "  would create $STAGING (0700 root:root)"
else
	sudo install -d -m 700 -o root -g root "$STAGING"
	say "  created $STAGING (0700 root:root)"
fi

# ---------------------------------------------------------------- report ----

step "Still needs a human"

if ((DRY_RUN)); then
	say "  (dry run: nothing was inspected)"
	exit 0
fi

# The same keys deploy/deploy.sh refuses to deploy without, so this list and that
# gate cannot drift into disagreeing about what a working configuration is.
blank=()
for key in ORIGIN PUBLIC_BASE_DOMAIN SITE_GATE MAIL_TRANSPORT; do
	value=$(sudo grep -E "^[[:space:]]*${key}=" "$APP_ENV" 2>/dev/null | head -n1 | cut -d= -f2- || true)
	[[ -n ${value//[[:space:]]/} ]] || blank+=("$key")
done

if ((${#blank[@]} == 0)); then
	say "  nothing. Run deploy/deploy.sh --dry-run."
else
	for key in "${blank[@]}"; do say "  $key"; done
	say ""
	say "  Edit with: sudo -e $APP_ENV"
	say "  Then:      deploy/deploy.sh --dry-run"
fi
