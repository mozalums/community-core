#!/usr/bin/env bash
set -uo pipefail
REVIEW_ROOT=${E44_REVIEW_ROOT:-$(git rev-parse --show-toplevel)}
readonly HERE="$REVIEW_ROOT/deploy"
readonly SUT="$HERE/deploy.sh"
source <(sed '/^# ----------------------------------------------------------------- layout ----/,$d' "$HERE/deploy.test.sh" | sed '/^HERE=/d; /^readonly HERE SUT=/d')

fixture
pin v0.1.1
sed -i.bak 's@cat "\(.*\)/built-sha" ;;@exit 1 ;;@' "$T/bin/docker"
STUB_CORE_TAG=v0.1.0 pinned
if ((rc == 7)); then
  ok 'R5: absent build stamp cannot bypass verification of both stamps'
else
  bad 'R5: absent build stamp cannot bypass verification of both stamps' "expected rc=7, actual rc=$rc" "$(cat "$T/out")"
fi
cleanup

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
