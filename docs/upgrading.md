# Upgrading

What a release of the platform may change under a running community, and what it may not. From `v0.1.0`, taking a minor or patch release needs no edit to your skin, your environment or your database: pull, deploy, done.

## Public interface

Four things are the interface a community builds on. Everything the promise in [release kinds](#release-kinds) covers is one of these:

| Interface                         | Where it is described                                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The `skin.yaml` format            | [Skins](skin.md), every key and its type                                                                                                                                      |
| The environment variables         | [Configuration](configuration.md), and [`deploy/deploy.env`](deployment.md#host-configuration-deploydeployenv)                                                                |
| `deploy/deploy.sh`'s command line | [Deployment](deployment.md#deploydeploysh): `--yes`, `--dry-run`, `--ref`, `--rollback`, `--no-migrate`, `--no-verify`, `--quiet`, `--no-color`, `--help`, and the exit codes |
| The database                      | [Data model](data-model.md): the tables, their columns, and the keys stored in `data` and `private_data`                                                                      |

Code outside the interface carries no promise: module names, function signatures, routes' internal structure, the CSS class names in platform markup, test helpers. A community that depends on one of those depends on something that can change in any release.

## Release kinds

Versions follow [semantic versioning](https://semver.org/). Each kind of release may do this much to the interface:

| Release          | May                                                                               | May not                                                        |
| ---------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Patch (`v0.1.1`) | Fix behavior so it matches the documentation                                      | Add, rename or remove anything in the interface                |
| Minor (`v0.2.0`) | Add a `skin.yaml` key, an environment variable, a `deploy.sh` flag, a migration   | Rename or remove anything; make a new key or variable required |
| Major (`v1.0.0`) | Rename or remove, with each break and its replacement listed in the release notes | Break something the notes do not list                          |

Within a minor or patch release:

- **Every new key and variable is optional and has a default.** A skin and an env file that worked on the previous release work unchanged.
- **Migrations run forward and at boot with no manual step.** `ensureSchema` applies them when the app starts, and `deploy/deploy.sh` runs them as its gating step first. A migration that would need the app stopped, as 13, 15 and 16 did before `v0.1.0`, is a major-release change.
- **A feature members can see arrives switched off in `skin.yaml`.** Upgrading never changes what a member sees until the community turns the feature on.

A major release's notes list every break and what replaces it. Read them before deploying one, and expect to edit your skin, your env file, or both.

## Enforcement

Two checks keep the promise from resting on memory:

- **Every released skin keeps loading.** `src/lib/skin/released/` holds one `skin.yaml` per core release, named by tag (`v0.1.0.yaml`), and a test loads each against the current schema. A change that stops one loading fails the gate by name. [Releasing](releasing.md) adds the file in the commit each tag names.
- **Each change upgrades a database built by the newest tag.** The `upgrade` job in `.github/workflows/ci.yml` runs `scripts/upgrade-check.sh`: it builds the newest `v{major}.{minor}.{patch}` tag, migrates and seeds a fresh database with that build, then starts the code under test on that database with the tag's default skin. It fails unless `/healthz` answers and every migration the code defines is in the ledger, applied by the app at boot with no manual step. Before the first tag it passes and says there is nothing to compare against.

What one community wants and another does not becomes a setting in core, never a fork: a field one community needs is a `fields` entry in its own skin.

## Not yet covered

- The upgrade check starts the app once on one seeded database. It proves the migrations apply and the app answers; it does not exercise sign-in, the directory or any other page against the upgraded data.
- The environment variables and `deploy/deploy.sh`'s command line have no automated check across releases yet: a renamed variable or flag is caught by review alone.
