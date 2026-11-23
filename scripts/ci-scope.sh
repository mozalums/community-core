#!/usr/bin/env bash
#
# Prints build=, deploy= and backup= (true or false) for CI's path-scoped jobs,
# one per line, in the form $GITHUB_OUTPUT reads.
#
# Usage: EVENT=<github event> BASE=<sha> HEAD=<sha> scripts/ci-scope.sh
#
# A pull request runs a scoped job only when it changes that job's subject. Any
# other event, a missing sha or a diff git cannot compute runs every job: a
# filter that cannot answer must not be the reason a check was skipped.

set -uo pipefail

all() {
	printf 'build=true\ndeploy=true\nbackup=true\n'
	exit 0
}

[[ ${EVENT:-} == pull_request && -n ${BASE:-} && -n ${HEAD:-} ]] || all
files=$(git diff --name-only "$BASE...$HEAD" 2>/dev/null) || all

# Every scope includes CI itself, so a change to what judges the code is
# judged by all of it.
readonly CI='^(\.github/workflows/|scripts/ci-scope)'
readonly BUILD='^(skin/|skin-repository/|static/|src/lib/skin/|src/e46-org-repos\.test\.ts|scripts/split-export\.sh|scripts/e4[45]-|vite\.config|svelte\.config|package\.json|pnpm-lock\.yaml|Dockerfile)'
readonly DEPLOY='^(deploy/|scripts/e44-|docker-compose|Dockerfile)'
readonly BACKUP='^deploy/backup'

scope() {
	if grep -qE "$1|$CI" <<<"$files"; then echo "$2=true"; else echo "$2=false"; fi
}
scope "$BUILD" build
scope "$DEPLOY" deploy
scope "$BACKUP" backup
