#!/usr/bin/env bash
#
# Drives deploy/backup.sh through its failure paths with the real rclone and
# age, against a local directory standing in for the bucket. Only docker (there
# is no postgres here) and curl (there is no monitor) are stubbed, because the
# defects these cases cover lived in how rclone answered, not in how the script
# read. BACKUP_SH and DEPLOY_SH point the cases at other copies of the scripts.

set -uo pipefail

HERE=$(cd -- "${BASH_SOURCE[0]%/*}" && pwd)
readonly HERE
readonly SUT=${BACKUP_SH:-$HERE/backup.sh}
readonly DEPLOY_SH=${DEPLOY_SH:-$HERE/deploy.sh}

[[ $EUID -eq 0 ]] || {
	echo "backup.sh refuses to run as anyone but root; run: sudo bash $0" >&2
	exit 2
}
for tool in rclone age age-keygen python3 timeout; do
	command -v "$tool" >/dev/null 2>&1 || {
		echo "missing: $tool" >&2
		exit 2
	}
done
REAL_RCLONE=$(command -v rclone)
export REAL_RCLONE

pass=0 fail=0
T=''
LISTENER=''

cleanup() {
	[[ -n $LISTENER ]] && kill "$LISTENER" 2>/dev/null
	[[ -n $T ]] && rm -rf "$T"
	T='' LISTENER=''
}
trap cleanup EXIT

result() {
	local name=$1 ok=$2 detail=$3
	if ((ok)); then
		printf 'ok   %-58s %s\n' "$name" "$detail"
		pass=$((pass + 1))
	else
		printf 'FAIL %-58s %s\n' "$name" "$detail"
		fail=$((fail + 1))
	fi
}

days_ago() { echo "@$(($(date +%s) - $1 * 86400))"; }

# The script is copied away from the checkout, because a deploy/deploy.env next
# to it would override the LOREM_* paths below with a real host's.
setup() {
	cleanup
	T=$(mktemp -d)
	mkdir -p "$T/deploy" "$T/bin" "$T/secrets" "$T/staging" "$T/remote"
	cp "$SUT" "$T/deploy/backup.sh"

	cat >"$T/bin/docker" <<'STUB'
#!/usr/bin/env bash
[[ $1 == compose && $2 == version ]] && exit 0
for arg; do
	case $arg in DUMP_NAME=*) name=${arg#*=} ;; esac
done
printf 'PGDMP stand-in for %s\n' "$name" >"$LOREM_BACKUP_DIR/$name"
STUB
	cat >"$T/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "$*" >>"$PINGS"
STUB
	# A copyto whose source does not match COPY_ONLY_MATCHING fails. That is
	# the mid-run change (a quota crossed, a key rotated) which separates two
	# uploads made to one remote in one run.
	cat >"$T/bin/rclone" <<'STUB'
#!/usr/bin/env bash
if [[ -n ${COPY_ONLY_MATCHING:-} ]]; then
	prev=''
	for arg; do
		[[ $prev == copyto && $arg != $COPY_ONLY_MATCHING ]] && exit 1
		prev=$arg
	done
fi
exec "$REAL_RCLONE" "$@"
STUB
	chmod +x "$T/bin/"*

	age-keygen -o "$T/key" 2>/dev/null
	: >"$T/rclone.conf"
	write_env "$T/remote"
}

write_env() {
	install -m 600 /dev/null "$T/secrets/backup.env"
	cat >"$T/secrets/backup.env" <<ENV
BACKUP_RCLONE_REMOTE="$1"
BACKUP_AGE_RECIPIENTS=$(age-keygen -y "$T/key")
RCLONE_CONFIG=$T/rclone.conf
BACKUP_HEARTBEAT_URL=https://heartbeat.invalid/ping
ENV
}

# Every deadline at 3 s, so a case that waits on a hung remote proves the
# cutoff fires without sitting out the production deadline.
run() {
	env BACKUP_PROBE_DEADLINE=3 BACKUP_LIST_DEADLINE=3 BACKUP_DELETE_DEADLINE=3 \
		BACKUP_UPLOAD_DEADLINE=3 BACKUP_HEARTBEAT_DEADLINE=3 \
		PATH="$T/bin:$PATH" PINGS="$T/pings" LOREM_SECRETS_DIR="$T/secrets" \
		LOREM_BACKUP_DIR="$T/staging" LOREM_BACKUP_LOCK="$T/lock" "$@"
}

backup() { run timeout "${LIMIT:-120}" bash "$T/deploy/backup.sh" "$@" >"$T/out" 2>&1; }

pinged() { [[ -s $T/pings ]]; }
yes_if() { if "$@"; then echo 1; else echo 0; fi; }

# --- 1: the prune reaches only what the backup writes -----------------------

setup
echo 'operator note' >"$T/remote/rclone-bucket-readme.txt"
echo 'old dump' >"$T/remote/lorem-host-20200101T031500Z.dump.age"
touch -d "$(days_ago 60)" "$T/remote/rclone-bucket-readme.txt" \
	"$T/remote/lorem-host-20200101T031500Z.dump.age"
backup --quiet
rc=$?
result "1: prune keeps a backdated object it did not write" \
	"$(yes_if test -f "$T/remote/rclone-bucket-readme.txt")" "rc=$rc"
result "1: prune still deletes a backdated dump" \
	"$(yes_if test ! -e "$T/remote/lorem-host-20200101T031500Z.dump.age")" "rc=$rc"

# --- 2: a hung destination does not stop the dump ---------------------------

# Accepts every connection and never answers, which is worse than a refused
# port: that one fails on the first packet.
setup
python3 -c '
import socket, sys
s = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(64)
print(s.getsockname()[1]); sys.stdout.flush()
held = []
while True:
    held.append(s.accept()[0])
' >"$T/port" &
LISTENER=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
	[[ -s $T/port ]] && break
	sleep 0.2
done
write_env ":webdav,url='http://127.0.0.1:$(cat "$T/port")':"

start=$SECONDS
LIMIT=30 backup --dry-run
rc=$? took=$((SECONDS - start))
result "2: --dry-run gives up on a hung remote at its probe deadline" \
	"$(yes_if test "$rc" = 5 -a "$took" -le 15)" "rc=$rc ${took}s"

# The upload after the dump spends its own, longer deadline; the case only
# needs to see that the dump got taken before that.
start=$SECONDS
LIMIT=30 backup --quiet
took=$((SECONDS - start))
shopt -s nullglob
queued=("$T/staging"/*.dump.age)
shopt -u nullglob
result "2: a hung remote still gets an encrypted dump taken" \
	"$(yes_if test "${#queued[@]}" = 1 -a -s "${queued[0]:-/nonexistent}")" "queued=${#queued[@]} ${took}s"

# --- 3: the heartbeat speaks for this run's dump ----------------------------

setup
echo 'queued by an earlier outage' >"$T/staging/lorem-host-20200101T031500Z.dump.age"
COPY_ONLY_MATCHING='*20200101T031500Z*' backup --quiet
rc=$?
shopt -s nullglob
own=("$T/staging"/lorem-host-2*.dump.age)
shopt -u nullglob
result "3: straggler uploads, own dump does not: no heartbeat" \
	"$(yes_if test ! -s "$T/pings" -a "$rc" = 5)" "rc=$rc pinged=$(pinged && echo yes || echo no)"
result "3: the straggler still reached the remote" \
	"$(yes_if test -f "$T/remote/lorem-host-20200101T031500Z.dump.age" -a "${#own[@]}" = 1)" \
	"own still queued=${#own[@]}"

setup
backup --quiet
rc=$?
result "3: a run whose own dump lands still pings" \
	"$(yes_if test -s "$T/pings" -a "$rc" = 0)" "rc=$rc"

# --- 4: the queue holds a re-upload to the checks that gated creation --------

setup
: >"$T/staging/lorem-host-20200102T031500Z.dump.age"
backup --quiet
rc=$?
result "4: an empty queued file is not uploaded" \
	"$(yes_if test ! -e "$T/remote/lorem-host-20200102T031500Z.dump.age")" "rc=$rc"
result "4: an empty queued file is not deleted as confirmed" \
	"$(yes_if test -e "$T/staging/lorem-host-20200102T031500Z.dump.age")" "rc=$rc"

# --- 5: a deploy says when nothing is backing the volume up ------------------

setup
timer_fn=$(awk '/^check_backup_timer\(\) \{/,/^}/' "$DEPLOY_SH")
timer_case() {
	rm -f "$T/bin/systemctl"
	if [[ $1 != absent ]]; then
		# The timer triggers a service whose ExecStart is this checkout's
		# backup.sh, which is what the check takes as evidence; "other" points it
		# at another checkout. An absolute interpreter: PATH holds nothing but
		# the stub directory.
		# shellcheck disable=SC2016 # the stub expands $1, not this shell
		printf '#!%s\n[[ $1 == list-unit-files ]] && { echo "community-backup.timer enabled enabled"; exit 0; }\n[[ $1 == is-enabled ]] && exit %s\n[[ $1 == show && $3 == Triggers ]] && { echo community-backup.service; exit 0; }\n[[ $1 == show && $3 == ExecStart ]] && { echo "{ path=%s/deploy/backup.sh ; argv[]=%s/deploy/backup.sh --quiet ; }"; exit 0; }\nexit 0\n' \
			"$BASH" "$([[ $1 == enabled || $1 == other ]] && echo 0 || echo 1)" \
			"$([[ $1 == other ]] && echo /srv/other || echo "$T/checkout")" "$T/checkout" >"$T/bin/systemctl"
		chmod +x "$T/bin/systemctl"
	fi
	env PATH="$T/bin" CORE_ROOT="$T/checkout" "$BASH" -c "
		say() { printf '%s\n' \"\$*\" >&2; }
		warn() { printf 'warning: %s\n' \"\$*\" >&2; }
		$timer_fn
		check_backup_timer" 2>&1
}
out=$(timer_case enabled)
result "5: enabled timer: no warning" "$(yes_if test -n "$timer_fn" -a "${out/warning/}" = "$out")" ""
out=$(timer_case other)
result "5: another checkout's enabled timer: warns that coverage is unconfirmed" \
	"$(yes_if test "${out/cannot be confirmed/}" != "$out" -a "${out/backups:/}" = "$out")" ""
out=$(timer_case disabled)
result "5: missing timer: warns that nothing is backed up" \
	"$(yes_if test "${out/NOT being backed up/}" != "$out")" ""
out=$(timer_case absent)
result "5: no systemctl: warns rather than staying silent" \
	"$(yes_if test "${out/warning/}" != "$out")" ""
calls=$(awk '/^# -+ main -+$/{m=1} m && /^[[:space:]]*check_backup_timer$/{n++} END{print n+0}' "$DEPLOY_SH")
result "5: deploy.sh calls it on the dry-run and the deployed path" \
	"$(yes_if test "$calls" = 2)" "calls=$calls"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
