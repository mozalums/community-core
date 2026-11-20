#!/usr/bin/env bash
set -uo pipefail
export BACKUP_SH=${BACKUP_SH:-$PWD/deploy/backup.sh}
source <(sed '/^# --- 1:/,$d' "$PWD/deploy/backup.test.sh")
setup
old=lorem-host-20200101T031500Z.dump.age
printf 'older queued dump\n' > "$T/staging/$old"
mkdir "$T/remote/$old"
printf 'conflicting remote entry\n' > "$T/remote/$old/entry"
backup --quiet
rc=$?
shopt -s nullglob
current_remote=("$T/remote"/lorem-host-20*.dump.age)
current_local=("$T/staging"/lorem-host-20*.dump.age)
shopt -u nullglob
uploaded=0
for path in "${current_remote[@]}"; do
    [[ -f $path && ${path##*/} != "$old" ]] && uploaded=$((uploaded + 1))
done
printf 'rc=%s current_uploaded=%s local_queue=%s\n' "$rc" "$uploaded" "${#current_local[@]}"
cat "$T/out"
[[ $uploaded -eq 1 ]]
