#!/usr/bin/env bash
set -uo pipefail
REVIEW_ROOT=${E44_REVIEW_ROOT:-$(git rev-parse --show-toplevel)}
readonly HERE="$REVIEW_ROOT/deploy"
readonly SUT="$HERE/deploy.sh"
source <(sed '/^# ----------------------------------------------------------------- layout ----/,$d' "$HERE/deploy.test.sh" | sed '/^HERE=/d; /^readonly HERE SUT=/d')
fixture
loose=$(sha "$T/core.git" main)
g "$T/host/core" checkout --quiet "$loose"
g "$T/host" add core
g "$T/host" commit --quiet -m 'local unreviewed core pin'
before=$(sha "$T/host")
pinned
if ((rc == 2)) && [[ $(sha "$T/host") == "$before" ]] && ! grep -qE ' (build|run) ' "$T/docker.log"; then
  ok 'R3 R4 R5: a local parent commit cannot deploy an untagged core under the origin stamp'
else
  bad 'R3 R4 R5: a local parent commit cannot deploy an untagged core under the origin stamp' \
    "expected rc=2 before build/migration, actual rc=$rc" \
    "actual parent=$(sha "$T/host"), image parent=$(cat "$T/built-sha")" \
    "actual core=$(sha "$T/host/core"), image tag='$(cat "$T/built-tag")'" \
    "$(cat "$T/out")"
fi
cleanup
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
