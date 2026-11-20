#!/usr/bin/env bash
set -uo pipefail
REVIEW_ROOT=${E44_REVIEW_ROOT:-$(git rev-parse --show-toplevel)}
readonly HERE="$REVIEW_ROOT/deploy"
readonly SUT="$HERE/deploy.sh"
source <(sed '/^# ----------------------------------------------------------------- layout ----/,$d' "$HERE/deploy.test.sh" | sed '/^HERE=/d; /^readonly HERE SUT=/d')
for next in same newer; do
  fixture
  first=$(sha "$T/host")
  first_core=$(sha "$T/host/core")
  pin v0.3.0
  g "$T/host" config submodule.core.update none
  pinned
  stopped_rc=$rc
  g "$T/host" config --unset submodule.core.update
  if [[ $next == newer ]]; then
    echo 'another site change' >> "$T/site-src/skin.yaml"
    g "$T/site-src" add skin.yaml
    g "$T/site-src" commit --quiet -m 'site only after stopped sync'
    g "$T/site-src" push --quiet origin main
  fi
  PATH="$T/bin:$PATH" LOREM_SECRETS_DIR="$T/secrets" \
    "$HERE/ci-deploy.sh" "$T/host/core/deploy/deploy.sh" </dev/null >"$T/ci-out" 2>&1
  ci_rc=$?
  reran=no
  grep -q 'Running again' "$T/ci-out" && reran=yes
  migration_warn=no
  grep -q 'migrations.ts changes in this range' "$T/ci-out" && migration_warn=yes
  if ((stopped_rc == 2 && ci_rc == 0)) && [[ $reran == yes ]]; then
    ok "R6: resumed sync ($next parent target) reruns the changed deploy script"
  else
    bad "R6: resumed sync ($next parent target) reruns the changed deploy script" \
      "stop rc=$stopped_rc, CI rc=$ci_rc, reran=$reran" "$(cat "$T/ci-out")"
  fi
  if ((stopped_rc == 2 && ci_rc == 0)) && [[ $migration_warn == yes ]]; then
    ok "R5: resumed sync ($next parent target) warns for the unapplied core migration range"
  else
    bad "R5: resumed sync ($next parent target) warns for the unapplied core migration range" \
      "stop rc=$stopped_rc, CI rc=$ci_rc, migration warning=$migration_warn"
  fi
  pinned --rollback
  if ((rc == 0)) && [[ $(sha "$T/host") == "$first" && $(sha "$T/host/core") == "$first_core" ]]; then
    ok "R6: resumed sync ($next parent target) preserves the rollback predecessor"
  else
    bad "R6: resumed sync ($next parent target) preserves the rollback predecessor" "rc=$rc" "$(cat "$T/out")"
  fi
  cleanup
done
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
