#!/usr/bin/env bash
set -uo pipefail
REVIEW_ROOT=${E44_REVIEW_ROOT:-$(git rev-parse --show-toplevel)}
readonly HERE="$REVIEW_ROOT/deploy"
readonly SUT="$HERE/deploy.sh"
source <(sed '/^# ----------------------------------------------------------------- layout ----/,$d' "$HERE/deploy.test.sh" | sed '/^HERE=/d; /^readonly HERE SUT=/d')
fixture
pin v0.1.1
g "$T/host" config submodule.core.ignore dirty
printf '\nexport const unreviewedMigration = 999;\n' >> "$T/host/core/src/lib/server/migrations.ts"
pinned
if ((rc == 2)) && out_has 'uncommitted changes' && ! grep -qE ' (build|run) ' "$T/docker.log"; then
  ok 'R6: actual core edits are refused even when parent status hides submodule dirt'
else
  bad 'R6: actual core edits are refused even when parent status hides submodule dirt' \
    "expected rc=2 before migration/build, actual rc=$rc" \
    "core status: $(g "$T/host/core" status --porcelain)" \
    "$(cat "$T/out")"
fi
cleanup
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
