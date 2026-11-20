#!/usr/bin/env bash
set -uo pipefail
REVIEW_ROOT=${E44_REVIEW_ROOT:-$(git rev-parse --show-toplevel)}
readonly HERE="$REVIEW_ROOT/deploy"
readonly SUT="$HERE/deploy.sh"
source <(sed '/^# ----------------------------------------------------------------- layout ----/,$d' "$HERE/deploy.test.sh" | sed '/^HERE=/d; /^readonly HERE SUT=/d')
REAL_GIT=$(command -v git)
export REAL_GIT
for recovery in advance rollback; do
  fixture
  first=$(sha "$T/host")
  first_core=$(sha "$T/host/core")
  pin v0.2.0
  g "$T/host" config submodule.core.update none
  pinned
  stop_rc=$rc
  g "$T/host" config --unset submodule.core.update
  if [[ $recovery == advance ]]; then pin v0.3.0; fi
  cat >"$T/bin/git" <<'STUB'
#!/usr/bin/env bash
if [[ $1 == merge || $1 == checkout ]]; then
  kill -TERM "$PPID"
  exit 0
fi
exec "$REAL_GIT" "$@"
STUB
  chmod +x "$T/bin/git"
  if [[ $recovery == advance ]]; then pinned; else pinned --rollback; fi
  interrupted_rc=$rc
  rm "$T/bin/git"
  marker=$(cat "$T/host/.git/lorem-deploy/core-transition")
  pinned --rollback
  if ((stop_rc == 2 && interrupted_rc == 130 && rc == 0)) &&
    [[ $(sha "$T/host") == "$first" && $(sha "$T/host/core") == "$first_core" ]]; then
    ok "R6: interrupt before a recovery $recovery preserves the earlier deploy-owned drift"
  else
    bad "R6: interrupt before a recovery $recovery preserves the earlier deploy-owned drift" \
      "stopped sync rc=$stop_rc, interrupted recovery rc=$interrupted_rc, rollback rc=$rc" \
      "transition=$marker" "$(cat "$T/out")"
  fi
  cleanup
done
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
