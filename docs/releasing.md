# Releasing

How a core version is tagged, and how a site's repository moves onto it. [Upgrading](upgrading.md) says what a version number promises; this page is the procedure that keeps the promise checkable.

## Tags

A release is a tag named `v{major}.{minor}.{patch}`: `v0.1.0`, `v0.2.0`, `v1.0.0`. Nothing else is a release. A site repository's CI and `deploy/deploy.sh` both refuse a pin on any other commit, and the upgrade job in `.github/workflows/ci.yml` skips past `v1.2.0-rc1` or `release-3` to the newest tag in that form.

**A tag is never moved and never deleted once pushed.** A site's pin, its deploy and the upgrade job all trust that a tag names one commit for good, and a host that already fetched it keeps the old commit under the same name with no error. A release with a mistake in it is followed by the next patch release, never repaired under its own tag.

Pick the number from what the release changes, using the [release kinds](upgrading.md#release-kinds) table: a patch fixes behavior to match the docs, a minor adds, a major renames or removes and lists each break in its notes.

## Tagging a release

The commit a tag names carries a copy of the default skin as that release ships it, at `src/lib/skin/released/{tag}.yaml`. The gate loads every file there against the current schema, so the next release is tested against this one's skin, and a change that would break a site still on this release fails by name (`src/lib/skin/released/README.md`).

From a clean `main` whose CI passed:

```bash
tag=v0.2.0
cp skin/default/skin.yaml "src/lib/skin/released/$tag.yaml"
git add "src/lib/skin/released/$tag.yaml"
git commit --message "release $tag"
git tag --annotate "$tag" --message "$tag"
git push origin main "$tag"
```

The copy and the tag go on the same commit. While core is private, a maintainer pushes that commit to `main` directly; once branch protection is on, it lands through a pull request and the tag goes on the commit that reached `main`. Check the result before announcing it:

```bash
git diff --exit-code "$tag:skin/default/skin.yaml" "$tag:src/lib/skin/released/$tag.yaml"
```

Then write the release notes on GitHub from the tag. A major release's notes list every break and what replaces it.

`v0.1.0` is the exception to the order above: core's repository starts from a single commit of an exported tree, and that commit is the one tagged. Its `src/lib/skin/released/v0.1.0.yaml` is therefore committed before the export, and the tag goes on the one commit after creation.

## Moving a site's pin

A site's repository holds core as a submodule at `core`, always on a release tag. Moving to a newer release is a commit in that repository, reviewed like any other:

```bash
cd core && git fetch --tags && git checkout v0.2.0 && cd ..
git add core
git commit --message 'core v0.2.0'
```

Read [upgrading](upgrading.md) for every release between the old pin and the new one before merging it. The guardrail treats the pin as a protected path, so the pull request needs a maintainer's approval. The site's CI refuses a pin that is not on a tag, and the next deploy after the merge moves the host: [the pinned layout](deployment.md#pinned-layout) covers what `deploy/deploy.sh` does with it.
