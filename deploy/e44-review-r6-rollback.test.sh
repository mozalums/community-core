#!/usr/bin/env bash
set -uo pipefail
REVIEW_ROOT=${E44_REVIEW_ROOT:-$(git rev-parse --show-toplevel)}
readonly HERE="$REVIEW_ROOT/deploy"
readonly SUT="$HERE/deploy.sh"
source <(sed '/^# ----------------------------------------------------------------- layout ----/,$d' "$HERE/deploy.test.sh" | sed '/^HERE=/d; /^readonly HERE SUT=/d')

fixture
first=$(sha "$T/host")
first_core=$(sha "$T/host/core")
pin v0.2.0
PATH="$T/bin:$PATH" LOREM_SECRETS_DIR="$T/secrets" \
  "$HERE/ci-deploy.sh" "$T/host/core/deploy/deploy.sh" </dev/null >"$T/ci-out" 2>&1
ci_rc=$?
reran=no
grep -q 'Running again' "$T/ci-out" && reran=yes
pinned --rollback
if ((ci_rc == 0 && rc == 0)) && [[ $reran == yes && $(sha "$T/host") == "$first" && $(sha "$T/host/core") == "$first_core" ]]; then
  ok 'R6: rollback after CI self-update rerun restores the old parent and core'
else
  bad 'R6: rollback after CI self-update rerun restores the old parent and core' \
    "CI rc=$ci_rc, reran=$reran, rollback rc=$rc" \
    "parent: want $first, got $(sha "$T/host")" \
    "core: want $first_core, got $(sha "$T/host/core")" "$(cat "$T/out")"
fi
cleanup
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
