#!/usr/bin/env bash
set -uo pipefail
REVIEW_ROOT=${E44_REVIEW_ROOT:-$(git rev-parse --show-toplevel)}
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
mkdir "$T/bin"
cat > "$T/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  list-unit-files) echo 'unrelated-backup.timer enabled enabled' ;;
  is-enabled|is-active) [[ ${*: -1} == unrelated-backup.timer ]] ;;
  *) exit 1 ;;
esac
STUB
chmod +x "$T/bin/systemctl"
export PATH="$T/bin:$PATH"
say() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*"; }
eval "$(sed -n '/^check_backup_timer() {/,/^}/p' "$REVIEW_ROOT/deploy/deploy.sh")"
out=$(check_backup_timer)
printf '%s\n' "$out"
if [[ $out == *warning:* && $out != *'  backups: unrelated-backup.timer'* ]]; then
  echo 'ok: an unrelated enabled timer does not count as this deployment being backed up'
else
  echo 'FAIL: an unrelated enabled timer suppressed the missing-backup warning'
  exit 1
fi
