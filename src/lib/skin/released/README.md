# Released skins

One `skin.yaml` per core release, named by tag: `v0.1.0.yaml`. Each is the default skin as that release shipped it.

`src/lib/skin/skin.test.ts` loads every file here against the current schema. That test failing is the definition of a breaking change to the skin format: it ships only in a major release, and the file it broke is removed in that release's commit, never edited.

[Releasing](../../../../docs/releasing.md) adds the file in the commit each tag names.
