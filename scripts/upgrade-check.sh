#!/usr/bin/env bash
#
# Fails unless a database built by the newest release takes the code under test
# with no manual step, the promise docs/upgrading.md makes for every minor and
# patch release. Core's CI runs it in the upgrade job.
#
# Usage: scripts/upgrade-check.sh <work-dir>
#
# Run from the checkout under test, with its dependencies installed and its tags
# fetched, against an empty Postgres database (POSTGRES_HOST, POSTGRES_PORT,
# POSTGRES_DATABASE, POSTGRES_USER, POSTGRES_PASSWORD) and a Redis (REDIS_URL).
# The newest v{major}.{minor}.{patch} tag is exported into <work-dir> and built,
# and its own scripts migrate and seed the database. The code under test is then
# built with that tag's default skin, which writes this checkout's build/, and
# started on the database. It passes once /healthz answers and the migration
# ledger holds every migration the code under test defines. The app applies
# migrations itself at boot and only logs a failure, so an answering health
# check alone would pass an upgrade that never migrated.
#
# With no release tag yet there is nothing to upgrade from, and it passes,
# saying so.

set -euo pipefail

readonly BOOT_SECONDS=90

die() {
	echo "upgrade-check: $*" >&2
	exit 1
}

(($# == 1)) || {
	echo "usage: scripts/upgrade-check.sh <work-dir>" >&2
	exit 2
}
work=$1
[[ ! -e $work ]] || die "$work already exists: name a new directory"

tag=$(git tag --list 'v*' --sort=-v:refname | sed -n '/^v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*$/{p;q;}')
if [[ -z $tag ]]; then
	echo "upgrade-check: no v{major}.{minor}.{patch} tag to compare against; nothing to upgrade from, so this passes"
	exit 0
fi
echo "upgrade-check: upgrading a database built by $tag to $(git rev-parse --short HEAD)"

released=$work/$tag
mkdir -p "$released"
released=$(cd "$released" && pwd -P)
git archive --format=tar "$tag" | tar -x -f - -C "$released"

# The release's own scripts and skin, from its own directory, so nothing of the
# code under test reaches the database before the upgrade.
(
	cd "$released"
	unset SKIN_DIR
	pnpm install --frozen-lockfile && pnpm build
) || die "$tag does not build"
(
	cd "$released"
	unset SKIN_DIR
	node_modules/.bin/tsx scripts/migrate.ts && node_modules/.bin/tsx scripts/seed.ts
) || die "$tag could not migrate and seed the database"

export SKIN_DIR=$released/skin/default
pnpm build || die "the code under test does not build with $tag's default skin"

port=${UPGRADE_CHECK_PORT:-5899}
log=$work/app.log
PORT=$port HOST=127.0.0.1 ORIGIN=http://127.0.0.1:$port node build/index.js >"$log" 2>&1 &
app=$!
trap 'kill "$app" 2>/dev/null || true; wait "$app" 2>/dev/null || true' EXIT

failed() {
	echo "--- app log ($log)" >&2
	cat "$log" >&2
	die "$*"
}

expected=$(node_modules/.bin/tsx --eval \
	"import { MIGRATIONS } from './src/lib/server/migrations.ts'; console.log(MIGRATIONS.length);")
applied() {
	node_modules/.bin/tsx --eval "
		import { scriptPool } from './scripts/db.ts';
		const pool = scriptPool();
		pool.query('SELECT count(*)::int AS n FROM schema_migrations')
			.then(({ rows }) => console.log(rows[0].n))
			.finally(() => pool.end());
	"
}

healthy=0 count=''
for ((i = 0; i < BOOT_SECONDS; i++)); do
	kill -0 "$app" 2>/dev/null || failed "the code under test exited on $tag's database"
	grep -q 'schema.migrate.error' "$log" && failed "the code under test could not migrate $tag's database at boot"
	((healthy)) || { curl -fsS "http://127.0.0.1:$port/healthz" >/dev/null 2>&1 && healthy=1; }
	if ((healthy)); then
		count=$(applied) || count=''
		[[ $count == "$expected" ]] && break
	fi
	sleep 1
done
((healthy)) || failed "the code under test did not answer /healthz within ${BOOT_SECONDS}s"
[[ $count == "$expected" ]] ||
	failed "the ledger holds ${count:-no} migrations after ${BOOT_SECONDS}s; the code under test defines $expected"

echo "upgrade-check: $tag's database took $(git rev-parse --short HEAD) at boot: /healthz answered and all $expected migrations are applied"
