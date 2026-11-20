#!/usr/bin/env bash
set -uo pipefail
REVIEW_ROOT=${E44_REVIEW_ROOT:-$(git rev-parse --show-toplevel)}
readonly HERE="$REVIEW_ROOT/deploy"
readonly SUT="$HERE/deploy.sh"
source <(sed '/^# ----------------------------------------------------------------- layout ----/,$d' "$HERE/deploy.test.sh" | sed '/^HERE=/d; /^readonly HERE SUT=/d')
REAL_GIT=$(command -v git)
export REAL_GIT
for history in first existing; do
  for recovery in rollback retry; do
    fixture
    if [[ $history == existing ]]; then
      pin v0.1.1
      pinned
      [[ $rc == 0 ]] || { cat "$T/out"; cleanup; exit 1; }
    fi
    before=$(sha "$T/host")
    before_core=$(sha "$T/host/core")
    pin v0.3.0
    cat >"$T/bin/git" <<'STUB'
#!/usr/bin/env bash
if [[ $1 == merge ]]; then
  "$REAL_GIT" "$@" || exit $?
  kill -TERM "$PPID"
  exit 0
fi
exec "$REAL_GIT" "$@"
STUB
    chmod +x "$T/bin/git"
    pinned
    stop_rc=$rc
    rm "$T/bin/git"
    saved=$(cat "$T/host/.git/lorem-deploy/prior-commit" 2>/dev/null || echo absent)
    resume_rc=0
    if [[ $recovery == retry ]]; then
      pinned
      resume_rc=$rc
    fi
    pinned --rollback
    if ((stop_rc == 130 && resume_rc == 0 && rc == 0)) &&
      [[ $(sha "$T/host") == "$before" && $(sha "$T/host/core") == "$before_core" ]]; then
      ok "R6: interruption after parent move preserves predecessor ($history history, $recovery)"
    else
      bad "R6: interruption after parent move preserves predecessor ($history history, $recovery)" \
        "stop rc=$stop_rc, retry rc=$resume_rc, rollback rc=$rc" \
        "wanted parent=$before, core=$before_core; saved predecessor=$saved" \
        "actual parent=$(sha "$T/host"), core=$(sha "$T/host/core")" "$(cat "$T/out")"
    fi
    cleanup
  done
done
for history in first existing; do
  fixture
  if [[ $history == existing ]]; then
    pin v0.1.1
    pinned
    [[ $rc == 0 ]] || { cat "$T/out"; cleanup; exit 1; }
  fi
  before=$(sha "$T/host")
  before_core=$(sha "$T/host/core")
  saved=$(cat "$T/host/.git/lorem-deploy/prior-commit" 2>/dev/null || echo absent)
  pin v0.3.0
  cat >"$T/bin/git" <<'STUB'
#!/usr/bin/env bash
if [[ $1 == merge ]]; then
  kill -TERM "$PPID"
  exit 0
fi
exec "$REAL_GIT" "$@"
STUB
  chmod +x "$T/bin/git"
  pinned
  rm "$T/bin/git"
  after=$(cat "$T/host/.git/lorem-deploy/prior-commit" 2>/dev/null || echo absent)
  if ((rc == 130)) && [[ $(sha "$T/host") == "$before" && $(sha "$T/host/core") == "$before_core" && $after == "$saved" ]]; then
    ok "R6: interruption before parent move leaves predecessor unchanged ($history history)"
  else
    bad "R6: interruption before parent move leaves predecessor unchanged ($history history)" \
      "rc=$rc, saved=$saved, after=$after" "$(cat "$T/out")"
  fi
  cleanup
done
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
