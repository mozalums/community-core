#!/usr/bin/env bash
#
# Runs one deploy and decides whether a second is owed.
#
# bash parsed deploy.sh's function bodies before the fast-forward replaced the
# file, so a range that changes deploy.sh is carried out by the version it
# replaced. That version can fail checks the new one fixes, so its verdict is not
# the deployment's verdict and a second run has to follow.
#
# The deploy command is an argument so this control flow can be driven by
# something other than ssh; deploy/ci-deploy.test.sh exercises every branch.
#
# Usage: deploy/ci-deploy.sh <command> [args...]

set -euo pipefail

(($#)) || {
	echo "usage: ci-deploy.sh <command> [args...]" >&2
	exit 1
}

# Emitted by checkout_target the moment it notices the change (deploy.sh:521),
# rather than the line printed on the way out. A failure anywhere after the
# fast-forward never reaches that closing line, and that is precisely the run
# whose verdict must not be trusted.
readonly SELF_UPDATE_NOTICE='changed in this range'

# deploy.sh writes its narration to stderr on purpose, keeping stdout free for
# machine-readable output, so 2>&1 is what makes the notice visible here at all.
# tee streams the first pass to the stderr this script inherited and keeps a
# private copy to search. Not `tee /dev/stderr`: on Linux that opens the
# caller's file anew with its own offset at zero, so when stdout and stderr
# share a redirected file every later write lands on top of the first pass.
capture=$(mktemp "${TMPDIR:-/tmp}/ci-deploy.XXXXXX")
trap 'rm -f -- "$capture"' EXIT
set +e
"$@" 2>&1 | tee "$capture" >&2
rc=${PIPESTATUS[0]}
set -e

if grep -q "$SELF_UPDATE_NOTICE" "$capture"; then
	echo "::notice::deploy.sh replaced itself; the first pass ran the old one. Running again."
	set +e
	"$@"
	rc=$?
	set -e
fi

exit "$rc"
