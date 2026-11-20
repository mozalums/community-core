#!/usr/bin/env bash
#
# Every case below is a bug that reached production. The deploy step is a
# decision made from two inputs, which stream the notice arrives on and what the
# first pass exits with, so it can be driven with a stub in milliseconds.

set -uo pipefail

readonly HERE=${BASH_SOURCE[0]%/*}
readonly SUT="$HERE/ci-deploy.sh"
readonly NOTICE='deploy/deploy.sh changed in this range. This run is the previous version;'
# In a site that pins core as a submodule the notice names the script by its
# path from the site's root.
readonly PINNED_NOTICE='core/deploy/deploy.sh changed in this range. This run is the previous version;'

pass=0 fail=0

# The stub answers as deploy.sh does: narration on stderr, and an exit code that
# can differ between the first pass and the second.
make_stub() {
	local dir=$1 stream=$2 first_rc=$3 second_rc=$4 notice=$5 text=${6:-$NOTICE}
	cat >"$dir/stub" <<STUB
#!/usr/bin/env bash
n=\$(cat "$dir/count" 2>/dev/null || echo 0)
n=\$((n + 1))
echo "\$n" > "$dir/count"
if [[ "$notice" == yes && \$n -eq 1 ]]; then
	if [[ "$stream" == stderr ]]; then echo "  $text" >&2; else echo "  $text"; fi
fi
echo "==> Preflight" >&2
if [[ \$n -eq 1 ]]; then exit $first_rc; else exit $second_rc; fi
STUB
	chmod +x "$dir/stub"
}

check() {
	local name=$1 stream=$2 first_rc=$3 second_rc=$4 notice=$5 want_runs=$6 want_rc=$7 text=${8:-$NOTICE}
	local dir
	dir=$(mktemp -d)
	make_stub "$dir" "$stream" "$first_rc" "$second_rc" "$notice" "$text"

	"$SUT" "$dir/stub" >/dev/null 2>&1
	local got_rc=$?
	local got_runs
	got_runs=$(cat "$dir/count" 2>/dev/null || echo 0)
	rm -rf "$dir"

	if [[ $got_runs == "$want_runs" && $got_rc == "$want_rc" ]]; then
		printf 'ok   %-46s runs=%s rc=%s\n' "$name" "$got_runs" "$got_rc"
		pass=$((pass + 1))
	else
		printf 'FAIL %-46s runs=%s (want %s) rc=%s (want %s)\n' \
			"$name" "$got_runs" "$want_runs" "$got_rc" "$want_rc"
		fail=$((fail + 1))
	fi
}

#     name                                    stream  rc1 rc2 notice runs rc
check "no self-update, success"               stderr   0   0  no      1    0
check "no self-update, failure propagates"    stderr   7   0  no      1    7
check "self-update, first pass succeeded"     stderr   0   0  yes     2    0
check "self-update, first pass failed"        stderr   7   0  yes     2    0
check "self-update, second pass fails"        stderr   0   7  yes     2    7
check "self-update, both passes fail"         stderr   7   7  yes     2    7
check "notice on stdout is still seen"        stdout   0   0  yes     2    0
check "pinned layout, first pass failed"      stderr   7   0  yes     2    0  "$PINNED_NOTICE"

# CI runs the wrapper with both streams in one redirected file. Linux gives a
# descriptor opened on that path its own offset, and the job log then loses the
# first pass under the second, which is the pass whose warnings matter.
shared_log() {
	local name='both passes survive a shared log file' dir want got
	dir=$(mktemp -d)
	make_stub "$dir" stderr 7 0 yes
	"$SUT" "$dir/stub" >"$dir/log" 2>&1
	want=$(printf '%s\n' "  $NOTICE" '==> Preflight' \
		'::notice::deploy.sh replaced itself; the first pass ran the old one. Running again.' '==> Preflight')
	got=$(cat "$dir/log")
	rm -rf "$dir"
	if [[ $got == "$want" ]]; then
		printf 'ok   %s\n' "$name"
		pass=$((pass + 1))
	else
		printf 'FAIL %s\n%s\n' "$name" "$got"
		fail=$((fail + 1))
	fi
}
shared_log

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
