#!/usr/bin/env bash
set -uo pipefail
REVIEW_ROOT=${E44_REVIEW_ROOT:-$(git rev-parse --show-toplevel)}
readonly HERE="$REVIEW_ROOT/deploy"
readonly SUT="$HERE/deploy.sh"
source <(sed '/^# ----------------------------------------------------------------- layout ----/,$d' "$HERE/deploy.test.sh" | sed '/^HERE=/d; /^readonly HERE SUT=/d')
for bit in assume-unchanged skip-worktree; do
  fixture
  pin v0.1.1
  g "$T/host/core" update-index "--$bit" src/lib/server/migrations.ts
  printf '\nexport const unreviewedMigration = 999;\n' >> "$T/host/core/src/lib/server/migrations.ts"
  pinned
  if ((rc == 2)) && ! grep -qE ' (build|run) ' "$T/docker.log"; then
    ok "R6: a tracked core edit hidden by $bit is refused before migration/build"
  else
    bad "R6: a tracked core edit hidden by $bit is refused before migration/build" \
      "expected rc=2 before migration/build, actual rc=$rc" \
      "core status: $(g "$T/host/core" status --porcelain=v2 --ignore-submodules=none --untracked-files=normal)" \
      "worktree marker count=$(grep -c unreviewedMigration "$T/host/core/src/lib/server/migrations.ts"), commit marker count=$(g "$T/host/core" show HEAD:src/lib/server/migrations.ts | grep -c unreviewedMigration)" \
      "$(cat "$T/out")"
  fi
  cleanup
done
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
