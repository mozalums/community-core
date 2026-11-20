#!/usr/bin/env bash
#
# Run one of this project's operational scripts on the deploy host.
#
# The scripts are `tsx`, and a deploy host need not carry Node or pnpm: the same
# reason migrations run through a compose profile. Everything they need is
# already in the `migrate` service: the build stage of the image, `scripts/`
# mounted read-only, the secrets file, and a place on the compose network where
# the name `postgres` resolves. This runs them there.
#
#   deploy/run.sh export-members example > roster.csv
#   deploy/run.sh import-members example - < roster.csv
#   deploy/run.sh prune-audit
#
# Rebuilds the image first, for the reason deploy.sh does: `compose run` reuses
# whatever image exists, so without it a script silently runs against whatever
# commit the image was last built from. A configuration change applied by stale
# code is worse than one that fails.

set -euo pipefail

readonly SCRIPTS_DIR='scripts'
REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_ROOT"

die() {
	printf 'error: %s\n' "$1" >&2
	shift
	for line in "$@"; do printf '       %s\n' "$line" >&2; done
	exit 1
}

available() {
	# The scripts a person would run, as opposed to the helpers they import.
	# db.ts is a connection factory and the check-*.ts pair runs in `pnpm check`.
	find "$SCRIPTS_DIR" -maxdepth 1 -name '*.ts' ! -name 'db.ts' ! -name 'check-*.ts' \
		-exec basename {} .ts \; | sort
}

usage() {
	cat <<EOF
Run a project script on the deploy host, inside the compose network.

Usage: deploy/run.sh <script> [args...]

Scripts:
$(available | sed 's/^/  /')

Examples:
  deploy/run.sh export-members example > roster.csv
  deploy/run.sh import-members example - < roster.csv
  deploy/run.sh prune-audit
EOF
}

[[ $# -ge 1 ]] || {
	usage
	exit 1
}
case "$1" in
	-h | --help)
		usage
		exit 0
		;;
esac

script=$1
shift
[[ -f "$SCRIPTS_DIR/$script.ts" ]] || die "No such script: $script" \
	"Run 'deploy/run.sh --help' for the list."

# Same split as deploy.sh: git and the checkout stay with the invoking user,
# and only the daemon call borrows sudo. Adding that user to the docker group
# would be root over every container on a shared host.
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
	if sudo -n true 2>/dev/null || { [[ -t 0 ]] && sudo -v; }; then
		DOCKER=(sudo docker)
	else
		die "Cannot reach the docker daemon, with or without sudo."
	fi
fi

# Host facts, read the way deploy.sh reads them so both reach the same stack.
if [[ -f deploy/deploy.env ]]; then
	set -a
	# shellcheck disable=SC1091
	. deploy/deploy.env
	set +a
fi
# Files rather than the environment, because sudo's env_reset drops exported
# variables before compose substitutes them; a host that moved its project name
# would otherwise run against the default stack. Same order as deploy.sh.
COMPOSE=(--env-file "${LOREM_SECRETS_DIR:-/data/secrets/lorem-host}/.env")
[[ -f deploy/deploy.env ]] && COMPOSE+=(--env-file deploy/deploy.env)

printf '==> %s %s\n' "$script" "$*" >&2
exec "${DOCKER[@]}" compose "${COMPOSE[@]}" \
	--profile migrate run --build --rm migrate \
	pnpm exec tsx "$SCRIPTS_DIR/$script.ts" "$@"
