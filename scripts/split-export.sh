#!/usr/bin/env bash
#
# Splits one commit of the repository the current directory is in into the two
# repositories it becomes:
#
#   <target-dir>/core  every tracked path except the community skin and skin-repository/
#   <target-dir>/skin  the community skin's contents at its root, plus skin-repository/'s
#
# Usage: scripts/split-export.sh [--init --author 'Name <email>' --date <date>] <target-dir> [commit]
#        (commit defaults to HEAD)
#
# Both trees come from `git archive` of the commit, never from the working
# tree, so an untracked, ignored or uncommitted file cannot reach either, and
# two runs on one commit write identical trees. The community skin is the one
# directory under skin/ besides skin/default, found rather than named so this
# script, which ships in core, names no community.
#
# Before reporting success it runs the commit's own scripts/check-neutral.ts
# over the exported core tree. On any hit it removes both trees and exits 1, so
# a tree that names the community is never left where it could be pushed.
#
# --init turns each tree into a new repository holding exactly one commit, with
# no remote, so publishing one cannot carry the history of the repository it
# came from. Author and committer are both the --author value and both dates the
# --date value, and git runs with no global or system configuration, so no
# hook, template or identity from the machine reaches the commit and two runs
# on one commit write the same commit ids. It then scans both repositories with
# gitleaks at GITLEAKS_VERSION, checked before anything is written; any finding
# removes both trees and exits 1. The scan takes gitleaks' default rules and
# ignores the tree's own .gitleaks.toml, .gitleaksignore and gitleaks:allow
# comments, because a tree must not be able to exempt itself from its own scan.

set -euo pipefail

readonly STARTER=skin-repository
# Core is public, so branch protection enforces its reviews and the guardrail
# is the skin repository's alone. A core that carries a copy, as an exported
# core does when a skin repository's CI stages its .github inside it, has it
# left out, so core never runs a second review check beside GitHub's.
readonly GUARDRAIL=(.github/workflows/guardrail.yml .github/guardrail)
readonly GITLEAKS_VERSION=8.30.1

die() {
	echo "split-export: $*" >&2
	exit 1
}

usage() {
	echo "usage: scripts/split-export.sh [--init --author 'Name <email>' --date <date>] <target-dir> [commit]" >&2
	exit 2
}

init=0 author='' date=''
while (($#)); do
	case $1 in
	--init) init=1 && shift ;;
	--author | --date)
		(($# >= 2)) || usage
		[[ $1 == --author ]] && author=$2 || date=$2
		shift 2
		;;
	--) shift && break ;;
	-*) usage ;;
	*) break ;;
	esac
done
(($# >= 1 && $# <= 2)) || usage
target=$1
rev=${2:-HEAD}

# The commit gets no identity or configuration from the machine running this.
isolated=(env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1)
if ((init)); then
	[[ $author =~ ^([^<>]*[^<>[:space:]])[[:space:]]+\<([^<>[:space:]]+@[^<>[:space:]]+)\>$ ]] ||
		die "--init needs --author 'Name <email>' for the one commit, got: ${author:-nothing}"
	[[ -n $date ]] || die "--init needs --date for the one commit (for example 2026-11-19T12:00:00Z)"
	isolated+=(
		GIT_AUTHOR_NAME="${BASH_REMATCH[1]}" GIT_AUTHOR_EMAIL="${BASH_REMATCH[2]}" GIT_AUTHOR_DATE="$date"
		GIT_COMMITTER_NAME="${BASH_REMATCH[1]}" GIT_COMMITTER_EMAIL="${BASH_REMATCH[2]}" GIT_COMMITTER_DATE="$date"
	)
	"${isolated[@]}" git var GIT_AUTHOR_IDENT >/dev/null 2>&1 ||
		die "--date $date is not a date git reads (for example 2026-11-19T12:00:00Z)"
	gitleaks=$(command -v gitleaks) ||
		die "--init scans both trees with gitleaks $GITLEAKS_VERSION before their first push, and none is on PATH. Install $GITLEAKS_VERSION: https://github.com/gitleaks/gitleaks/releases/tag/v$GITLEAKS_VERSION"
	found=$("$gitleaks" version 2>/dev/null) || found='a version it would not print'
	[[ ${found#v} == "$GITLEAKS_VERSION" ]] ||
		die "--init scans with gitleaks $GITLEAKS_VERSION; $gitleaks is $found. Install $GITLEAKS_VERSION: https://github.com/gitleaks/gitleaks/releases/tag/v$GITLEAKS_VERSION"
elif [[ -n $author || -n $date ]]; then
	die "--author and --date set the commit --init makes; without --init there is no commit"
fi

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
tsx=$here/../node_modules/.bin/tsx
[[ -x $tsx ]] || die "no tsx at $tsx: run pnpm install in $(dirname "$here") first"

repo=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this from inside the repository to split"
sha=$(git -C "$repo" rev-parse --verify --quiet "$rev^{commit}") || die "$rev names no commit in $repo"

skin=$(git -C "$repo" ls-tree -d --name-only "$sha" skin/ | sed '/^skin\/default$/d')
[[ -n $skin && $skin != *$'\n'* ]] ||
	die "expected one community skin under skin/ besides skin/default at ${sha:0:12}, found: ${skin:-none}"
git -C "$repo" cat-file -e "$sha:$STARTER" 2>/dev/null ||
	die "${sha:0:12} has no $STARTER/ directory: the skin repository's starter files are missing"

# A starter file landing on a skin file of the same name would silently replace
# it, and which one won would depend on extraction order.
clash=$(comm -12 \
	<(git -C "$repo" ls-tree -r --name-only "$sha" -- "$skin/" | sed "s#^$skin/##" | sort) \
	<(git -C "$repo" ls-tree -r --name-only "$sha" -- "$STARTER/" | sed "s#^$STARTER/##" | sort))
[[ -z $clash ]] || die "$skin/ and $STARTER/ both carry: $(echo "$clash" | tr '\n' ' ')"

for repo_dir in "$target" "$target/core" "$target/skin"; do
	[[ ! -e $repo_dir/.git ]] ||
		die "$repo_dir/.git exists: the export writes new repositories and never into an existing one; name a new target"
done
if [[ -e $target || -L $target ]]; then
	[[ -d $target && ! -L $target && -z $(ls -A "$target") ]] ||
		die "$target already exists and is not an empty directory: name a new one"
fi
mkdir -p "$target/core" "$target/skin"
target=$(cd "$target" && pwd -P)

git -C "$repo" archive --format=tar "$sha" -- . ":(exclude)$skin" ":(exclude)$STARTER" "${GUARDRAIL[@]/#/:(exclude)}" |
	tar -x -f - -C "$target/core"
git -C "$repo" archive --format=tar "$sha" -- "$skin/" |
	tar -x -f - -C "$target/skin" --strip-components="$(($(tr -cd / <<<"$skin" | wc -c) + 1))"
git -C "$repo" archive --format=tar "$sha" -- "$STARTER/" |
	tar -x -f - -C "$target/skin" --strip-components=1

check=$target/core/scripts/check-neutral.ts
if [[ ! -f $check ]]; then
	rm -rf -- "$target/core" "$target/skin"
	die "${sha:0:12} has no scripts/check-neutral.ts, so its core tree cannot be checked; nothing exported"
fi
# The verdict is the check's own success line, not only its exit status: a
# check that never reached its main block also exits 0.
if ! verdict=$("$tsx" "$check" --tree "$target/core") || [[ $verdict != neutral:* ]]; then
	rm -rf -- "$target/core" "$target/skin"
	die "the core tree at ${sha:0:12} is not neutral (hits above${verdict:+; the check printed: $verdict}); both trees removed"
fi
echo "$verdict"

if ((init)); then
	# --force: every exported file is tracked in the source commit, and a
	# .gitignore inside the tree must not drop one from the only commit.
	for tree in core skin; do
		"${isolated[@]}" git init --quiet --initial-branch=main "$target/$tree"
		"${isolated[@]}" git -C "$target/$tree" add --all --force
		"${isolated[@]}" git -C "$target/$tree" commit --quiet --message 'Initial commit'
		[[ $("${isolated[@]}" git -C "$target/$tree" rev-list --count HEAD) == 1 &&
			-z $("${isolated[@]}" git -C "$target/$tree" remote) ]] ||
			die "$target/$tree is not one commit with no remote; nothing should be pushed from it"
	done

	rules=$(mktemp -d)
	trap 'rm -rf -- "$rules"' EXIT
	printf '[extend]\nuseDefault = true\n' >"$rules/gitleaks.toml"
	leaked=()
	for tree in core skin; do
		"${isolated[@]}" "$gitleaks" git --no-banner --no-color --verbose --redact --ignore-gitleaks-allow \
			--config "$rules/gitleaks.toml" --gitleaks-ignore-path "$rules" "$target/$tree" >&2 ||
			leaked+=("$tree")
	done
	if ((${#leaked[@]})); then
		rm -rf -- "$target/core" "$target/skin"
		die "gitleaks $GITLEAKS_VERSION reported findings in ${leaked[*]} (above, redacted) or could not scan it; both trees removed"
	fi
	echo "gitleaks $GITLEAKS_VERSION: no findings in core or skin"
fi

echo "split-export: ${sha} ($skin) exported"
for tree in core skin; do
	line="  $tree  $target/$tree  $(find "$target/$tree" -path "$target/$tree/.git" -prune -o -type f -print | wc -l | tr -d ' ') files"
	((init)) && line+="  one commit $("${isolated[@]}" git -C "$target/$tree" rev-parse HEAD)"
	echo "$line"
done
