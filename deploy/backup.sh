#!/usr/bin/env bash
#
# Dump lorem-host's Postgres off the box, encrypted.
#
# Runs from a systemd timer (deploy/systemd/), never as a resident process:
# `docker compose --profile backup run --rm backup` starts a container, writes
# one dump and exits. Nothing new stays running on the host.
#
#   deploy/backup.sh              # dump, encrypt, upload, prune, heartbeat
#   deploy/backup.sh --dry-run    # print the resolved config and probe the remote
#   deploy/backup.sh --check      # is there a recent dump on the remote?
#   deploy/backup.sh --list       # what is on the remote
#
# Three properties this has that a `pg_dump | gzip > /backups` cron line does
# not, and which are the whole reason it is a script rather than a line:
#
#   1. The heartbeat fires only after this run's own dump is confirmed present
#      on the remote at the byte count it was written with. So the alert is
#      "no successful dump in longer than the interval", which is also what an
#      expired credential, a full bucket and a timer nobody enabled look like.
#      A job that only reports its own errors cannot report never having started.
#   2. A dump that cannot be uploaded is encrypted, kept, and retried by the
#      next run, oldest first. The staging directory is a queue, not a second
#      copy: anything the remote confirms is deleted locally, so the cleartext
#      dump exists on this shared host for the seconds between pg_dump and age,
#      and the encrypted one for as long as the remote is unreachable.
#   3. The retention prune refuses to run when nothing recent is on the remote,
#      so a run that could not upload cannot also delete the history.
#
# Exit codes are distinct so a caller can tell the classes apart without parsing
# prose: 1 usage, 2 precondition, 3 config, 4 dump, 5 upload, 6 absence.

set -euo pipefail

readonly E_USAGE=1 E_PRECONDITION=2 E_CONFIG=3 E_DUMP=4 E_UPLOAD=5 E_ABSENCE=6

# Host facts, shared with deploy/deploy.sh and with the compose file through the
# environment. Read before the constants below so they can default through it,
# and computed here rather than from REPO_ROOT, which is not resolved yet.
# Exported, because the compose run further down substitutes from the
# environment and must land on the same paths this script checked.
_deploy_env=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/deploy.env
if [[ -f $_deploy_env ]]; then
	set -a
	# shellcheck disable=SC1090
	. "$_deploy_env"
	set +a
fi
unset _deploy_env

# Same variable docker-compose.yml and deploy/deploy.sh read, so all three agree
# about where this host keeps its configuration.
readonly SECRETS_FILE=${LOREM_SECRETS_DIR:-/data/secrets/lorem-host}/backup.env
# Overridable because a host with a different disk layout should not need a
# patch, and because it is the only way to exercise this end to end anywhere
# but production. docker-compose.yml reads the same variable for the bind
# mount, so the container and this script cannot disagree about the path.
readonly STAGING="${LOREM_BACKUP_DIR:-/var/backups/lorem-host}"
readonly LOCK_FILE=${LOREM_BACKUP_LOCK:-/var/lock/lorem-host-backup.lock}

# What the remote holds that is ours. The absence check and the retention prune
# both read it, so what counts as "a recent dump" and what is eligible for
# deletion cannot drift apart; the destination is a prefix someone may share.
readonly DUMP_PATTERN='*.age'

# Flags make a dead destination fail fast; they do not bound a call. --timeout
# is idle time, and a backend's retry pacer sleeps outside network I/O: B2
# honoring a Retry-After of 600 waits ten minutes with no idle timer running.
# So every call also runs under an elapsed deadline enforced by a kill
# (rclone_within). docs/operations.md, "What a dead destination costs a run",
# adds these up against the unit's TimeoutStartSec.
readonly RCLONE_PROBE=(--contimeout 10s --timeout 10s --retries 1 --low-level-retries 2)
readonly RCLONE_BOUNDED=(--contimeout 10s --timeout 60s --retries 1 --low-level-retries 3)
readonly PROBE_DEADLINE=20 LIST_DEADLINE=60 DELETE_DEADLINE=120 UPLOAD_DEADLINE=900
# curl's -m bounds one attempt, not the sleep between them, and a monitor's
# Retry-After overrides --retry-delay: a 503 asking for 7200 waits two hours.
readonly HEARTBEAT_DEADLINE=60
# Older queued dumps are not started once the upload phase has spent this long,
# so a slow but working destination cannot spend the run's own dump's time.
readonly STRAGGLER_BUDGET=600

REPO_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
readonly REPO_ROOT

MODE=run
QUIET=0
AGE_ARGS=()

if [[ -t 2 ]]; then
	C_GREEN=$'\033[32m' C_YELLOW=$'\033[33m' C_OFF=$'\033[0m'
else
	C_GREEN='' C_YELLOW='' C_OFF=''
fi
readonly C_GREEN C_YELLOW C_OFF

say() { ((QUIET)) || printf '%s\n' "$*" >&2; }
step() { ((QUIET)) || printf '\n%s==>%s %s\n' "$C_GREEN" "$C_OFF" "$*" >&2; }
warn() { printf '%swarning:%s %s\n' "$C_YELLOW" "$C_OFF" "$*" >&2; }

die() {
	local code=$1
	shift
	printf 'error: %s\n' "$1" >&2
	shift
	for line in "$@"; do printf '       %s\n' "$line" >&2; done
	exit "$code"
}

usage() {
	cat <<EOF
Dump lorem-host's Postgres off the box, encrypted.

Usage: deploy/backup.sh [--dry-run | --check | --list]

  (no flag)   dump, encrypt, upload, prune, heartbeat
  --dry-run   print the resolved config and probe the remote, change nothing
  --check     exit $E_ABSENCE when no dump on the remote is newer than
              BACKUP_MAX_AGE_HOURS; this is the absence test, by hand
  --list      list the remote

Configuration lives in $SECRETS_FILE (root:root 0600).
See docs/operations.md, "Backups".
EOF
}

while [[ $# -gt 0 ]]; do
	case "$1" in
		-h | --help)
			usage
			exit 0
			;;
		--dry-run) MODE=dry-run ;;
		--check) MODE=check ;;
		--list) MODE=list ;;
		--quiet) QUIET=1 ;;
		*)
			usage >&2
			die "$E_USAGE" "Unknown argument: $1"
			;;
	esac
	shift
done
readonly MODE QUIET

# --- preconditions ----------------------------------------------------------

preflight() {
	[[ $EUID -eq 0 ]] || die "$E_PRECONDITION" \
		"Must run as root." \
		"The secrets file is root:root 0600, the staging directory is 0700, and" \
		"the docker socket is root's on a shared host. Use: sudo $0"

	local missing=() tool
	for tool in docker age rclone curl timeout; do
		command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
	done
	[[ ${#missing[@]} -eq 0 ]] || die "$E_PRECONDITION" \
		"Missing on this host: ${missing[*]}" \
		"apt-get install -y age rclone curl coreutils   # docker is already here"

	docker compose version >/dev/null 2>&1 ||
		die "$E_PRECONDITION" "docker compose (v2) is not available."

	# 0700 rather than 0755. A dump is cleartext between pg_dump and age, and
	# a shared host's other tenants have no business reading the member
	# directory during that window.
	install -d -m 700 "$STAGING"
	install -d -m 755 "$(dirname "$LOCK_FILE")"
}

# systemd will not start a Type=oneshot unit that is already running; a human
# running this by hand while the timer fires will. Two concurrent pg_dumps
# against a 512 MB Postgres is a thing to discover now rather than during the
# incident.
take_lock() {
	if command -v flock >/dev/null 2>&1; then
		exec 9>"$LOCK_FILE"
		flock -n 9 || die "$E_PRECONDITION" "Another backup run holds $LOCK_FILE."
	else
		warn "flock is absent; concurrent runs are not prevented."
	fi
}

# --- configuration ----------------------------------------------------------

load_config() {
	[[ -r $SECRETS_FILE ]] || die "$E_CONFIG" \
		"Cannot read $SECRETS_FILE" \
		"docs/operations.md, \"Backups\", has the file it expects."

	local mode
	mode=$(stat -c '%a' "$SECRETS_FILE" 2>/dev/null || stat -f '%Lp' "$SECRETS_FILE")
	[[ $mode == 600 ]] || warn "$SECRETS_FILE is mode $mode; it should be 600."

	set -a
	# shellcheck disable=SC1090
	. "$SECRETS_FILE"
	set +a

	: "${BACKUP_RCLONE_REMOTE:?is required, e.g. b2:example-backups/postgres}"
	: "${BACKUP_AGE_RECIPIENTS:?is required, e.g. age1... age1...}"
	: "${RCLONE_CONFIG:=/data/secrets/lorem-host/rclone.conf}"
	: "${BACKUP_RETENTION_DAYS:=30}"
	: "${BACKUP_MAX_AGE_HOURS:=26}"
	export RCLONE_CONFIG

	[[ -r $RCLONE_CONFIG ]] || die "$E_CONFIG" "Cannot read $RCLONE_CONFIG"

	# The one failure nothing downstream can catch. The identity that decrypts
	# these is deliberately not on this host, so nothing here can prove a dump
	# is readable — a recipient that is well-formed but not yours is found
	# during the restore drill or during the incident. Rejecting a malformed one
	# costs nothing and removes the common half of that.
	local rcpt
	for rcpt in $BACKUP_AGE_RECIPIENTS; do
		printf '' | age -r "$rcpt" >/dev/null 2>&1 ||
			die "$E_CONFIG" "Not a usable age recipient: $rcpt"
		AGE_ARGS+=(-r "$rcpt")
	done

	# Stated, not defaulted. Without a dead-man's switch nothing outside this
	# box notices that backups stopped, which is the failure this exists to
	# close, so skipping it has to be a sentence someone wrote.
	if [[ -z ${BACKUP_HEARTBEAT_URL:-} ]]; then
		[[ ${BACKUP_HEARTBEAT_OPTIONAL:-} == 'true' ]] || die "$E_CONFIG" \
			"BACKUP_HEARTBEAT_URL is unset." \
			"Absence is the alert that matters: a job that only reports its own" \
			"errors cannot report never having started. Point it at a dead-man's" \
			"switch, or set BACKUP_HEARTBEAT_OPTIONAL=true to accept that nothing" \
			"off this host is watching."
		warn "No heartbeat: nothing off this host will notice backups stopping."
	fi
}

# --- remote -----------------------------------------------------------------

# --foreground keeps rclone in this script's process group, so whatever stops
# the script (systemd, a wrapping timeout, ^C) stops the call too. Without it
# timeout moves rclone into a group of its own, and a killed run leaves it
# holding the destination and the output pipes until its own deadline.
rclone_within() {
	local seconds=$1
	shift
	timeout --foreground -k 5 "$seconds" rclone "$@"
}

# rclone's own --max-age filter answers "is anything recent here" exactly, with
# no timestamp parsing on a host whose date(1) may be BSD or GNU.
remote_recent() {
	rclone_within "$LIST_DEADLINE" "${RCLONE_BOUNDED[@]}" lsf --files-only --include "$DUMP_PATTERN" \
		--max-age "${BACKUP_MAX_AGE_HOURS}h" "$BACKUP_RCLONE_REMOTE" 2>/dev/null
}

remote_size_of() {
	rclone_within "$LIST_DEADLINE" "${RCLONE_BOUNDED[@]}" lsf --files-only --include "$1" --format s \
		"$BACKUP_RCLONE_REMOTE" 2>/dev/null
}

# Advisory in a normal run: an unreachable remote must not stop the dump, or a
# week-long outage at the destination leaves a week with no dump anywhere. The
# encrypted file queues and the run still exits non-zero from flush_queue.
# A hung remote counts as unreachable, which is why this probe has the shortest
# deadline in the script: it is the only rclone call that runs before pg_dump.
check_destination() {
	rclone_within "$PROBE_DEADLINE" "${RCLONE_PROBE[@]}" lsjson --max-depth 1 "$BACKUP_RCLONE_REMOTE" >/dev/null 2>&1 &&
		return 0
	warn "Cannot list $BACKUP_RCLONE_REMOTE — unreachable, or the credential is rejected."
	warn "  rclone --config $RCLONE_CONFIG lsd ${BACKUP_RCLONE_REMOTE%%:*}:"
	return 1
}

# --- the work ---------------------------------------------------------------

take_dump() {
	local name=$1
	step "pg_dump -Fc through the compose network"
	# --profile backup rather than a bare `docker run`: postgres publishes no
	# port, so its name resolves on that network and nowhere else. Same
	# constraint the migrate profile exists for.
	LOREM_BACKUP_DIR="$STAGING" docker compose --profile backup run --rm \
		-e DUMP_NAME="$name" backup ||
		die "$E_DUMP" "pg_dump failed; nothing was written under $name."

	[[ -s "$STAGING/$name" ]] ||
		die "$E_DUMP" "The container exited zero but $STAGING/$name is missing or empty."

	say "  $(du -h "$STAGING/$name" | cut -f1)	$name"
}

encrypt() {
	local name=$1
	step "age: encrypting to $((${#AGE_ARGS[@]} / 2)) recipient(s)"
	age "${AGE_ARGS[@]}" -o "$STAGING/$name.age.part" "$STAGING/$name"
	[[ -s "$STAGING/$name.age.part" ]] || die "$E_DUMP" "age produced an empty file."
	mv "$STAGING/$name.age.part" "$STAGING/$name.age"
	chmod 600 "$STAGING/$name.age"
	# The cleartext copy goes now, not at the end of the run. Nothing after this
	# point needs it, and every minute it stays is a minute the whole member
	# directory sits unencrypted on a host four other sites share.
	rm -f "$STAGING/$name"
}

# Uploads one queued file and confirms it at the same, non-empty size before
# deleting it locally. Returns non-zero and leaves the file queued otherwise.
upload_one() {
	local file=$1 base local_size remote_size
	base=$(basename "$file")
	# take_dump and encrypt refuse to produce an empty file, so one here was
	# put by someone or something else, and 0 == 0 would confirm it.
	if [[ ! -s $file ]]; then
		warn "$base is empty; not uploading it. Nothing this script writes is empty: inspect it and remove it."
		return 1
	fi
	if ! rclone_within "$UPLOAD_DEADLINE" "${RCLONE_BOUNDED[@]}" copyto "$file" "$BACKUP_RCLONE_REMOTE/$base"; then
		warn "upload of $base failed or passed ${UPLOAD_DEADLINE}s; keeping it for the next run."
		return 1
	fi
	local_size=$(wc -c <"$file" | tr -d ' ')
	remote_size=$(remote_size_of "$base" || true)
	if [[ $remote_size != "$local_size" ]]; then
		warn "remote reports '${remote_size:-nothing}' for $base, local is $local_size; keeping it for the next run."
		return 1
	fi
	rm -f "$file"
	say "  $base	$local_size bytes, confirmed on the remote"
}

# Ships older queued dumps first, oldest first, then this run's own ($1).
#
# The older ones stop at the first failure or once STRAGGLER_BUDGET is spent,
# and the rest stay queued: a remote that just failed one is likely to fail the
# next, and each costs up to a full UPLOAD_DEADLINE. This run's own dump is
# attempted whatever happened to them, because one old file the remote rejects
# for its own reasons (a name conflict, an object over the remaining quota)
# would otherwise stop every later dump from leaving the host.
#
# Succeeds only when the own dump is confirmed. A straggler reaching the remote
# says nothing about whether today's did, and the heartbeat after this must not
# report one as the other.
flush_queue() {
	local own=$1 uploaded=0 started=$SECONDS file
	shopt -s nullglob
	local queue=("$STAGING"/*.age)
	shopt -u nullglob
	[[ -s $STAGING/$own ]] || die "$E_UPLOAD" "This run's dump, $own, is not in $STAGING."

	step "Uploading ${#queue[@]} dump(s) to $BACKUP_RCLONE_REMOTE"
	while IFS= read -r file; do
		[[ $(basename "$file") == "$own" ]] && continue
		if ((SECONDS - started >= STRAGGLER_BUDGET)); then
			warn "Upload has run $((SECONDS - started))s; leaving the remaining older dumps for the next run."
			break
		fi
		if [[ ! -s $file ]]; then
			upload_one "$file" || true
			continue
		fi
		upload_one "$file" || break
		uploaded=$((uploaded + 1))
	done < <(printf '%s\n' "${queue[@]}" | sort)

	local own_confirmed=0
	upload_one "$STAGING/$own" && own_confirmed=1

	shopt -s nullglob
	local pending=("$STAGING"/*.age)
	shopt -u nullglob
	[[ ${#pending[@]} -eq 0 ]] ||
		warn "${#pending[@]} dump(s) still queued in $STAGING; the next run retries them."

	((own_confirmed)) || die "$E_UPLOAD" \
		"This run's dump, $own, did not reach $BACKUP_RCLONE_REMOTE ($uploaded older dump(s) did)." \
		"The only copy is on the same disk as the volume it protects, which" \
		"survives a bad migration and nothing else. No heartbeat was sent, so" \
		"the absence alert fires on schedule."
}

# Deleting dumps past the window is a privacy control, not housekeeping: each
# one is a full copy of the member directory, private fields included.
# docs/operations.md, "Retention", has the reasoning for the default.
prune_remote() {
	step "Retention: $BACKUP_RETENTION_DAYS days"
	if [[ -z $(remote_recent || true) ]]; then
		# The guard the sheet sync learned the hard way: a run that added
		# nothing is never the run that deletes the history.
		warn "No dump on the remote newer than ${BACKUP_MAX_AGE_HOURS}h; refusing to prune."
		return 0
	fi
	rclone_within "$DELETE_DEADLINE" "${RCLONE_BOUNDED[@]}" delete --include "$DUMP_PATTERN" \
		--min-age "${BACKUP_RETENTION_DAYS}d" "$BACKUP_RCLONE_REMOTE" ||
		warn "Prune failed; dumps past the window are still on the remote."
}

heartbeat() {
	[[ -n ${BACKUP_HEARTBEAT_URL:-} ]] || return 0
	step "Heartbeat"
	# Last, and reached only once this run's own dump was confirmed on the
	# remote. Anything earlier would report a backup that does not exist yet.
	if timeout --foreground -k 5 "$HEARTBEAT_DEADLINE" \
		curl -fsS -m 15 --retry 3 --retry-delay 5 -o /dev/null "$BACKUP_HEARTBEAT_URL"; then
		say "  pinged"
	else
		# Not fatal: the dump is off the box, which is the property that
		# matters. The monitor pages for absence, which is the right answer to
		# "we cannot tell whether it worked".
		warn "Heartbeat ping failed. The dump is on the remote; the monitor will report absence."
	fi
}

check_freshness() {
	local recent
	recent=$(remote_recent || true)
	if [[ -z $recent ]]; then
		printf 'ABSENT: no dump on %s newer than %sh\n' \
			"$BACKUP_RCLONE_REMOTE" "$BACKUP_MAX_AGE_HOURS"
		exit "$E_ABSENCE"
	fi
	printf 'OK: %d dump(s) on %s newer than %sh\n' \
		"$(printf '%s\n' "$recent" | wc -l | tr -d ' ')" \
		"$BACKUP_RCLONE_REMOTE" "$BACKUP_MAX_AGE_HOURS"
}

# --- main -------------------------------------------------------------------

cd "$REPO_ROOT"

preflight
load_config

case "$MODE" in
	list)
		rclone_within "$LIST_DEADLINE" "${RCLONE_BOUNDED[@]}" lsl "$BACKUP_RCLONE_REMOTE"
		exit 0
		;;
	check)
		check_freshness
		exit 0
		;;
	dry-run)
		cat <<EOF
remote        $BACKUP_RCLONE_REMOTE
rclone config $RCLONE_CONFIG
recipients    $BACKUP_AGE_RECIPIENTS
staging       $STAGING
retention     $BACKUP_RETENTION_DAYS days
absence after $BACKUP_MAX_AGE_HOURS hours
heartbeat     ${BACKUP_HEARTBEAT_URL:-NOT CONFIGURED}
would run     docker compose --profile backup run --rm backup
EOF
		check_destination || exit "$E_UPLOAD"
		say "remote reachable"
		exit 0
		;;
esac

take_lock
check_destination || warn "Dumping anyway; the encrypted file queues for the next run."

DUMP_NAME="lorem-host-$(date -u +%Y%m%dT%H%M%SZ).dump"
take_dump "$DUMP_NAME"
encrypt "$DUMP_NAME"
flush_queue "$DUMP_NAME.age"
prune_remote
heartbeat

step "Done"
