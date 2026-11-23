# Testing

What CI checks, what each check exists to catch, and when it runs.
Every job is defined in `.github/workflows/ci.yml`.

## Jobs

| Job       | Runs on                                                            | Catches                                                                                                                                        |
| --------- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`   | every PR and push                                                  | Code that does not type-check (`pnpm check`) or does not build (`pnpm build`)                                                                  |
| `test`    | every PR and push, in 3 shards                                     | Wrong behavior: search, field privacy, admin-only pages, sign-in and passkeys, import and export, profile links, migrations, the browser forms |
| `upgrade` | every PR and push                                                  | A database built by the newest release tag that this code cannot migrate without a manual step                                                 |
| `build`   | a change to the skin, the split, the build config or CI            | A build that carries a community's skin into core, or two skins that serve each other's files                                                  |
| `deploy`  | a change under `deploy/`, `docker-compose.yml`, `Dockerfile` or CI | A deploy that breaks a running site: the wrong core pin, a failed rollback, an interrupted update, a migration run with writers up             |
| `backup`  | a change to `deploy/backup*` or CI                                 | Backups that stop silently, delete files they did not write, or hang on a throttled destination or heartbeat monitor                           |

A push to `main` runs every job whatever it changed, so a path filter that misses a file lets one PR through and never `main`.
`scripts/ci-scope.sh` decides which path-scoped jobs a PR needs, and `scripts/ci-scope.test.sh` checks that decision before the `changes` job uses it.
When the script cannot compute a diff it runs every job.

## The test job

`test` runs `src/**/*.test.ts` and `scripts/*.test.*` with `node --test`, split by `--test-shard` across three runners.
Each runner has its own Postgres 17.4, the version `docker-compose.yml` pins, and sets `AUDIT_TEST_DATABASE_URL` to it, so the database tests run in CI rather than only on a developer's machine.

The suite holds three kinds of test:

- **Unit tests** call a module with its dependencies stubbed through `mock.module`.
- **Database tests** (`*.pg.test.ts`) run real SQL against that Postgres. They skip, saying why, when `AUDIT_TEST_DATABASE_URL` is unset. Search, field visibility, member writes, imports and the audit log are tested here because a stubbed query cannot show what Postgres does with the SQL.
- **Browser tests** mount a Svelte component in headless Chromium and drive it with real clicks and keys. `scripts/chromium.ts` downloads the Chromium build `playwright-core` pins on first use.

`src/lib/server/member-search-speed.pg.test.ts` times a search over 1000 members against an unfiltered directory load on the same machine, and fails a search that costs more than 60 such loads.
It exists because a search that took three seconds passed every other test.

Tests whose name contains `[build]` build the whole site, at 15 to 30 seconds each.
`test` skips them by name, and `build` runs only them.

## Running tests locally

```bash
pnpm test                                   # everything except the database tests
AUDIT_TEST_DATABASE_URL=postgres://user:pass@127.0.0.1:5432/test pnpm test
```

Point `AUDIT_TEST_DATABASE_URL` at a database you can throw away: the tests create and delete groups and members in it.
Run against a shared database, some files collide on fixture names when `node --test` runs them in parallel; `--test-concurrency=1` avoids that.

The deploy and backup tests are shell and Python scripts that need Linux.
The backup tests also need `age`, `rclone` and `curl`, and run as root in CI:

```bash
bash deploy/deploy.test.sh
sudo bash deploy/backup.test.sh
```

`deploy/backup.sh` reads each of its deadlines from the environment (see [Operations](operations.md#backups)), and the backup tests set them to 3 seconds, so a test proves a cutoff fires without waiting out the production deadline.
