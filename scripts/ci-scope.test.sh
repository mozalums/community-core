#!/usr/bin/env bash
#
# scripts/ci-scope.sh decides which CI jobs run, so a wrong answer skips a
# check with nothing reporting it. CI's `changes` job runs this before trusting
# that answer. It uses a real repository because the script's only input is
# what `git diff` says changed.

set -uo pipefail

SCOPE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/ci-scope.sh
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
fail=0

cd "$T" || exit 1
git init -q && git config user.email t@example.org && git config user.name t
git commit -q --allow-empty -m base
BASE_SHA=$(git rev-parse HEAD)

scope_for() {
	git checkout -q "$BASE_SHA" 2>/dev/null
	mkdir -p "$(dirname "$1")" && echo x >"$1" && git add "$1" && git commit -q -m change
	EVENT=pull_request BASE=$BASE_SHA HEAD=$(git rev-parse HEAD) bash "$SCOPE" | tr '\n' ' '
}

expect() {
	if [[ $2 == "$3" ]]; then
		echo "ok   $1"
	else
		echo "FAIL $1: got '$2', want '$3'"
		fail=1
	fi
}

expect 'a page change runs no scoped job' "$(scope_for src/routes/+page.svelte)" 'build=false deploy=false backup=false '
expect 'a skin change runs the build tests' "$(scope_for skin/default/skin.yaml)" 'build=true deploy=false backup=false '
expect 'a deploy change runs the deploy tests' "$(scope_for deploy/deploy.sh)" 'build=false deploy=true backup=false '
expect 'a backup change runs deploy and backup tests' "$(scope_for deploy/backup.sh)" 'build=false deploy=true backup=true '
expect 'a Dockerfile change runs build and deploy tests' "$(scope_for Dockerfile)" 'build=true deploy=true backup=false '
expect 'a workflow change runs every job' "$(scope_for .github/workflows/ci.yml)" 'build=true deploy=true backup=true '
expect 'a change to the filter runs every job' "$(scope_for scripts/ci-scope.sh)" 'build=true deploy=true backup=true '
expect 'a push runs every job' "$(EVENT=push bash "$SCOPE" | tr '\n' ' ')" 'build=true deploy=true backup=true '
expect 'a missing base runs every job' "$(EVENT=pull_request HEAD=x bash "$SCOPE" | tr '\n' ' ')" 'build=true deploy=true backup=true '
expect 'an unknown sha runs every job' \
	"$(EVENT=pull_request BASE=0000000000000000000000000000000000000000 HEAD=$BASE_SHA bash "$SCOPE" | tr '\n' ' ')" \
	'build=true deploy=true backup=true '

exit $fail
