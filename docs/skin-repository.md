# Skin repository

A community that runs this platform keeps its own site in a repository of its own: the skin at the root, its deploy files and runbook beside it, and core pinned as a git submodule at `core` on a release tag. This page covers creating that repository from the starter files core ships, what its two workflows do, the GitHub settings they depend on, and what GitHub's free plan leaves unenforced. [Deployment](deployment.md#pinned-layout) covers the host side of the same layout.

## Layout

```text
skin.yaml  theme.css  copy/  static/      the skin, the four entries the image takes
deploy/                                   the site's vhosts, units and env template
RUNBOOK.md                                the site's values and procedures
MAINTAINERS                               logins that may approve pull requests
LICENSE                                   the license of the site's own files
.github/workflows/ci.yml                  validate, build, test, deploy
.github/workflows/guardrail.yml           the review requirement
.github/guardrail/guardrail.mjs           the guardrail's decision
.github/pull_request_template.md
.gitmodules  core/                        core, pinned at a vX.Y.Z tag
```

The starter files are kept in `skin-repository/` of the tree being split, laid out as they sit at the skin repository's root, and the split moves them out of core. From then on the skin repository's copies are the ones to edit. Core's tests for them stay in core and skip when the files are absent; the skin repository's CI puts its `.github` back at `core/skin-repository/` before running core's tests, so every change to the guardrail or the workflows is tested against those tests.

## Creating one

From a checkout that still holds a community skin under `skin/<id>`, `scripts/split-export.sh` writes both trees from one commit:

```bash
pnpm install
scripts/split-export.sh --init --author 'Your Name <you@example.org>' --date 2026-11-19T12:00:00Z /tmp/split
# HEAD; or name a commit after the target
```

`/tmp/split/core` is every tracked file except `skin/<id>` and `skin-repository/`; core leaves out any guardrail workflow or script, because branch protection enforces its reviews. `/tmp/split/skin` is the contents of `skin/<id>` at its root plus the starter files. Both come from `git archive` of the commit, so nothing untracked, ignored or uncommitted reaches either, and two runs on one commit write identical trees. The target must not exist or must be empty, and a `.git` in it is refused by name. Before it reports success, the script runs the commit's own `scripts/check-neutral.ts` over the core tree; on any hit it prints them, removes both trees and exits 1.

**`--init` makes each tree a new repository with exactly one commit and no remote**, so pushing it cannot publish the history of the repository it was split from: every earlier state of the code, the docs and the fixtures stays where it was. The commit's author and committer are both `--author`, its dates both `--date`, and git runs without your global or system configuration, so no hook, commit template or signing setup reaches it, and two runs on one commit produce the same commit ids. Both values are required.

It then scans both repositories with [`gitleaks`](https://github.com/gitleaks/gitleaks) at the version the script pins (`GITLEAKS_VERSION` at its top, 8.30.1), and refuses to start without that version on `PATH`, naming it. The scan uses `gitleaks`' default rules and ignores the tree's own `.gitleaks.toml`, `.gitleaksignore` and `gitleaks:allow` comments, so a file committed in the tree has no effect on the scan of it. On any finding it prints each one with the secret redacted, removes both trees and exits 1. A test fixture that has to look like a credential is spelled in parts, as `src/lib/server/redact-fixture.ts` does, so no credential-shaped literal appears in the file.

Then publish the two repositories. Core first, because the skin pins a tag of it:

```bash
cd /tmp/split/core
git tag --annotate v0.1.0 --message v0.1.0
git remote add origin git@github.com:<owner>/<core>.git
git push origin main v0.1.0

cd /tmp/split/skin
git submodule add https://github.com/<owner>/<core>.git core
git -C core checkout v0.1.0
git add -A && git commit --message 'site on core v0.1.0'
git remote add origin git@github.com:<owner>/<site>.git
git push origin main
```

The skin's second commit is the one that adds the pin. [Releasing](releasing.md) covers tagging later versions and moving the pin. The submodule URL is HTTPS so CI can fetch it with a token; a host with a deploy key overrides it locally with `git config submodule.core.url`, as [the pinned layout](deployment.md#pinned-layout) shows. Put at least one login in `MAINTAINERS` before the first push: with the file empty, every pull request fails the guardrail.

## CI workflow

`.github/workflows/ci.yml` runs on every pull request and every push to `main`. The `check` job:

1. Checks out with submodules. One token fetches both this repository and core: `CORE_READ_TOKEN` when it is set, which is needed while core is private and so must read both, and the workflow's own token otherwise, which reads this repository alone.
2. Fails unless the `core` submodule's commit is exactly a `v{major}.{minor}.{patch}` tag on core's `origin`, the same rule `core/deploy/deploy.sh` enforces on the host. A commit between tags, or one tagged only `v1.2.0-rc1`, is refused with the command that moves the pin.
3. Installs core's dependencies and validates the skin with `core/scripts/check-skin.ts`, which copies out the four entries the image takes and runs core's skin loader on them. It prints the skin's `id`, or every refusal naming the file and key.
4. Builds the image from core with the repository root as the `skin` build context.
5. Copies the skin, `RUNBOOK.md`, `deploy/` and `MAINTAINERS` into `core/skin/<id>` and `.github` into `core/skin-repository/`, stages them in the runner's copy of core, runs `svelte-kit sync`, and runs core's `pnpm test`. Core's tests were written beside one community skin and the starter files at those paths, and some read the tracked file list, so this reproduces the layout they expect, and core's guardrail tests run on this repository's guardrail. Nothing is committed or pushed.

A newer push to the same branch cancels an older run's `check` job only. The cancellation is set on that job rather than on the workflow, because a workflow-level group would cancel the older run's `deploy` job too.

The `deploy` job runs after `check`, on a push to `main` only, and never cancels a deploy in flight: deploys share one group with cancellation off, so a later one waits. It deploys through `core/deploy/ci-deploy.sh` with four secrets: `DEPLOY_SSH_KEY`, `DEPLOY_HOST`, `DEPLOY_KNOWN_HOSTS` and the optional `DEPLOY_USER` (default `deploy`). With any of the first three unset the job fails, because a green deploy that deployed nothing hides a site running behind `main`. A repository that deploys nowhere sets the repository variable `DEPLOY_DISABLED` to `true`, and the job then succeeds with a notice. The host's `authorized_keys` forces the key's command, which in this layout is `<checkout>/core/deploy/deploy.sh --yes`.

## Guardrail workflow

`.github/workflows/guardrail.yml` runs on `pull_request` (opened, synchronize, reopened, edited, ready for review) and `pull_request_review` (submitted, edited, dismissed). It checks out the base branch, not the pull request, and runs `.github/guardrail/guardrail.mjs`, which reads the pull request through the API with a read-only token and fails the check unless one of these holds:

- The author is a login in `MAINTAINERS`.
- A login in `MAINTAINERS` has an approving review on the pull request's current head commit. An approval of an earlier commit does not count, and a later request for changes or a dismissal withdraws one.

A maintainer's own pull request passes without review: a maintainer can push to `main` directly, so a second approval on their pull request would protect nothing, and a site with one maintainer could never merge. Add a second login to `MAINTAINERS` and review each other by habit if you want two sets of eyes; the guardrail does not enforce it. The failure names any protected path the change touches, so the reviewer knows to read those first: anything under `deploy/` or `.github/`, `.gitmodules`, `MAINTAINERS`, and every submodule path `.gitmodules` declares, which is the `core` pin. A rename counts at both its old and new path.

`MAINTAINERS` holds one GitHub login per line; `#` starts a comment and a leading `@` is optional. The guardrail reads it, and `.gitmodules`, from the base branch, so a pull request that adds its author to `MAINTAINERS` is still judged by the list on `main`. A missing or empty file fails every pull request.

A pull request listing more files than GitHub's files endpoint returns (3,000) fails, because a protected path past that point would go unseen.

## Organization settings

The workflows assume the repository is set up this way. Check each when the repository is created; none of them is visible from the repository's files.

- **Members hold Read and contribute from forks.** Only maintainers get Write. On a private repository that makes `main` writable by maintainers alone, which is the only thing standing in for branch protection, and it keeps pull requests on forks, where a workflow never sees the deploy secrets.
- **Forking of private repositories is allowed** in the organization's member privileges, or members with Read cannot open a pull request at all.
- **Workflows run on pull requests from forks** (repository settings, Actions, "Run workflows from fork pull requests"). Without it the guardrail never runs on a member's pull request and shows no status. Leave "Send secrets to workflows from fork pull requests" off.
- **`CORE_READ_TOKEN`** while core is private: a fine-grained token with Contents read on two repositories, core and this one. The checkout action fetches this repository and its submodule with the same token, so a token that reads core alone fails before the first check runs. A fork's pull request does not receive it, so CI on a member's pull request fails at checkout until core is public; a maintainer re-runs the change from a branch in the repository to test it.
- **The four `DEPLOY_*` secrets**, set on this repository only.

## What the free plan does not enforce

GitHub Free gives a private repository no branch protection, no required status checks and no CODEOWNERS enforcement. So:

- **The guardrail is a status, not a gate.** A red check does not stop the merge button. Whoever holds Write can merge over it, push to `main` directly, or force-push. The guardrail tells a maintainer a merge is not reviewed; the access settings above are what keep non-maintainers from merging.
- **A pull request can edit the guardrail workflow.** On `pull_request`, GitHub runs the workflow file from the pull request's merge commit, so a change to `guardrail.yml` can make its own check pass. Checking out the base branch protects the script and `MAINTAINERS`, not the workflow file. `.github/` is a protected path for this reason: such a pull request still needs another maintainer's approval, and the maintainer reviewing it should read that file's diff first.
- **Each event leaves its own check.** A run from `pull_request_review` does not replace the failing run from `pull_request` on the same commit; the newest `Guardrail` run is the verdict.
- **CODEOWNERS** would only request reviewers. `MAINTAINERS` replaces it here.

When the repository moves to a plan with branch protection, make `Guardrail / maintainer-approval` and `CI / check` required checks on `main` and keep the workflow; it then becomes the gate this page says it is not.

## Core's own repository

Core is public, so the free plan gives it rulesets, and those enforce its reviews instead of the guardrail. The export leaves the guardrail out of core. Two rulesets cover `main`, split so that a maintainer can skip review without skipping CI:

- **`main: review`** requires a pull request with one approval from a code owner. `.github/CODEOWNERS` assigns every path to the maintainers (`* @mankins @ravinald`), and one approval from either is enough: GitHub asks for any one owner on a line, never all of them. `MAINTAINERS` lists the same logins for people reading the repository. The repository's admin role, which the maintainers hold, may bypass this ruleset from a pull request only, so a maintainer merges their own pull request without another review, the rule the guardrail applied before. GitHub never counts an author's approval of their own pull request, which is why this is a bypass and not an approval.
- **`main: checks`** requires every job in `.github/workflows/ci.yml` to pass: `changes`, `check`, `test (1)`, `test (2)`, `test (3)`, `upgrade`, `build`, `deploy` and `backup`. Nobody may bypass it. A path-scoped job skipped on a pull request reports as skipped, which satisfies a required check, so requiring all of them costs a pull request nothing and holds one that touches `deploy/` to the `deploy` tests. Requiring only `check` would let a pull request with failing tests merge, since the tests run in the `test` jobs.

A release reaches core as a pull request from a release branch, like any other change: no push to `main` can satisfy `main: checks`, because the checks run on a pull request.

A job renamed or added in `ci.yml` has to be renamed or added in `main: checks` too: a required check that no job reports stays pending, and blocks every merge.
