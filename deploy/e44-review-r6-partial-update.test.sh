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
g "$T/host" config submodule.core.update none
pinned
failed_rc=$rc
cp "$T/out" "$T/failed-out"
g "$T/host" config --unset submodule.core.update
pinned --rollback
if ((failed_rc == 2 && rc == 0)) && [[ $(sha "$T/host") == "$first" && $(sha "$T/host/core") == "$first_core" ]]; then
  ok 'R6: rollback restores both repositories after a stopped submodule update'
else
  bad 'R6: rollback restores both repositories after a stopped submodule update' \
    "failed deploy rc=$failed_rc, rollback rc=$rc" \
    "parent: want $first, got $(sha "$T/host")" \
    "core: want $first_core, got $(sha "$T/host/core")" \
    "first deploy:" "$(cat "$T/failed-out")" "rollback:" "$(cat "$T/out")"
fi
cleanup
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
