# Deployment

How to put the platform on a host, keep it updated, and move it. The site runs as the `Dockerfile` / `docker-compose.yml` stack behind a reverse proxy, on `adapter-node`. The examples use `www.example.org`, a checkout at `/srv/community/www`, and the default secrets directory `/data/secrets/lorem-host`; every one of those is yours to change, and [host configuration](#host-configuration-deploydeployenv) is where the paths are set.

The compose project directory is the checkout, and every command here is relative to it. The deploying user needs sudo.

**Develop locally, deploy by pulling.** A deploy host is not assumed to carry Node 22 or pnpm, so there is no `pnpm dev`, `check`, `test` or `build` on it: the only build that happens there happens inside the `Dockerfile`. On a host shared with other tenants there is a second reason, which is that an edit made in place is an unreviewed change to a machine other people depend on. Work locally, run the gate, push, then pull.

`svelte.config.js` names one adapter unconditionally, so `pnpm build` has one output, `build/index.js`, wherever it runs.

## First install

Standing this up on a host that has never run it. Ordered so the reversible steps come first: nothing is serving until step 7.

**1. Prerequisites on the host.** Docker with the Compose v2 plugin, nginx, certbot, git. Node and pnpm are not needed: the image builds them. The deploying user needs `sudo` but **not** the `docker` group, which is root over every container on the box and a much larger grant than the deploy needs. `deploy/deploy.sh` resolves `sudo docker` on its own.

**2. A read-only deploy key**, so the host pulls with a credential of its own rather than a forwarded agent. On the host:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/community-deploy -N '' -C "$(hostname) deploy"
cat >> ~/.ssh/config <<'EOF'

Host github.com
    HostName github.com
    User git
    IdentityFile ~/.ssh/community-deploy
    IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
```

Register `~/.ssh/community-deploy.pub` on the repository as a deploy key with **write access off**, then prove both directions:

```bash
ssh -o BatchMode=yes -T git@github.com     # names the repository, not the user
git push --dry-run                          # must be refused
```

`IdentitiesOnly yes` is what stops ssh falling back to a forwarded agent, which would make the deploy work only while a person is logged in. A deploy key binds to one repository, and `IdentitiesOnly yes` offers one key per `Host` block, so a host that pulls from two repositories needs two keypairs and two `Host` aliases (`Host github-second`, with `HostName github.com`) rather than a second `IdentityFile`. `deploy.sh` reads `origin` and `main` and never names a repository, so switching which one a host tracks is `git remote set-url` and nothing else.

**3. The checkout**, owned by the deploying user, never by root. Its location is free: `deploy.sh` and `deploy/backup.sh` resolve the repository root from their own path.

```bash
sudo mkdir -p /srv/community && sudo chown "$USER:$USER" /srv/community
git clone git@github.com:<owner>/<repository>.git /srv/community/www
cd /srv/community/www
cp deploy/deploy.env.example deploy/deploy.env
```

The one place the path is written down is the backup systemd unit, which names it twice. Core ships it as an example pair, `deploy/systemd/example-backup.service` and `example-backup.timer`: copy both and edit the path, as [backups](operations.md#backups) shows, and keep your copies with your site's files rather than editing core's.

A site that keeps its skin in its own repository and pins core inside it clones differently; see [pinned layout](#pinned-layout).

`deploy/deploy.env` is the [host configuration](#host-configuration-deploydeployenv). Every line of the example is commented out, so the copy selects the defaults, and the file exists on every host so that every manual `docker compose` command in these pages can name it with `--env-file deploy/deploy.env`. Uncomment what differs now, before `bootstrap.sh` reads it.

**4. The secrets files**, `root:root 0600` in a `0750` directory. Only the docker daemon reads them, so the deploying user does not need to:

```bash
deploy/bootstrap.sh --dry-run                               # what it would create, writing nothing
deploy/bootstrap.sh --origin https://www.example.org
```

It creates the directory, generates `postgres.env` with a random password, and writes `.env` from a template carrying **the same three database values**. That last part is the reason it exists: the database container spells the name `POSTGRES_DB` and the app spells it `POSTGRES_DATABASE`, so the pair is easy to write down twice and get wrong once. `--origin` also sets `PUBLIC_BASE_DOMAIN` to the apex, never `www`; [configuration](configuration.md#hostname-public_base_domain--origin) says why the cookie needs that.

The template is `.env.example` unless `--env-example FILE` names another, which is how a community seeds its own values: keep a copy of `.env.example` with your domain and mail host in your skin, for example `skin/your-community/deploy/env.example`, and pass that. A relative path is read from the checkout root.

Re-running it never rewrites a secrets file that already exists, because the copy on the host is the only copy of values nothing else stores. It finishes by naming what still needs a person, which on a fresh host is `SITE_GATE`, plus the `SMTP_*` set if sign-in mail is to work:

```bash
sudo -e /data/secrets/lorem-host/.env      # $LOREM_SECRETS_DIR/.env
```

In the same edit, name the first administrator. `ADMIN_SUBJECTS` grants admin by session subject, needs no roster row, and is the way in on a host where the directory is still empty:

```dotenv
ADMIN_SUBJECTS=email:you@example.org
```

In the same edit, select your skin. `SKIN_DIR` is the image's `skin` build context, a path relative to core's checkout, and without it every build compiles core's neutral default (see [skins](skin.md#skin-selection)):

```dotenv
SKIN_DIR=skin/your-community
```

Set both now, before step 7 creates the app container: compose reads the secrets file when it creates a container, so an edit made afterwards reaches the app only after `up -d` recreates it.

Everything else has a default, and every enumerated value refuses to boot on one it does not recognize rather than guessing. [Configuration](configuration.md) lists each variable. `deploy/deploy.sh` checks the same list before it restarts anything.

**5. DNS**, before certbot: point every name the site answers to at the host, and confirm they resolve there. `certonly --nginx` answers an http-01 challenge through the running nginx, so a name that does not yet resolve fails the issuance.

**6. TLS and nginx.** `deploy/nginx/example.conf` is the server-block template, and its header carries the certbot command and the install steps. Copy it, replace `example.org`, issue the certificate, then install it. Keep the edited copy with your site's files, not in core's `deploy/nginx`. [Reverse proxy](operations.md#reverse-proxy) explains each line.

**7. Schema and start.** Every command goes through `dc`, which hands compose the secrets `.env` and `deploy/deploy.env` the way `deploy.sh` does (see [host configuration](#host-configuration-deploydeployenv)). sudo resets the environment, so without the files compose falls back to the default project, port and secrets path, which on a shared host is somebody else's stack, and builds core's default skin. Build the schema first:

```bash
cd /srv/community/www
set -a; . deploy/deploy.env; set +a
dc() { sudo docker compose --env-file "${LOREM_SECRETS_DIR:-/data/secrets/lorem-host}/.env" --env-file deploy/deploy.env "$@"; }
dc --profile migrate run --build --rm migrate
```

Migrations create tables, not a community. The app serves the group named by `site.default_group` in your skin's `skin.yaml` and answers 404 until that row exists, so create it, with your skin's `default_group` and `name`:

```bash
dc exec -T postgres \
  sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <<'SQL'
INSERT INTO "group" (slug, name, landing_md)
VALUES ('your-group', 'Your Community', E'# Your Community\n\nA place to see what''s happening here.\n')
ON CONFLICT (slug) DO NOTHING;
SQL
```

`pnpm seed` is not the production path: it inserts the same row plus five invented members. The landing text is a placeholder an administrator replaces from the site. Then start the app:

```bash
dc up -d --build
```

Postgres and Redis come up as compose services with named volumes, prefixed by the compose project: `lorem-host_postgres-data` and `lorem-host_redis-data` unless `COMPOSE_PROJECT_NAME` says otherwise. `postgres-data` is the one that matters, and backing it up is a separate install step: see [backups](operations.md#backups), and do it before real members exist. Until the timer is installed, `deploy/deploy.sh` ends every deploy and dry run with a warning that nothing is backing the volume up.

**8. Prove it.** `/healthz` answers 200 on an empty database, so it proves the process and nothing else:

```bash
curl -sI https://www.example.org/healthz                  # 200
curl -s  -o /dev/null -w '%{http_code}\n' https://www.example.org/   # 200; 404 means no group row
dc ps                                                      # three services, all healthy
```

Then sign in as the address in `ADMIN_SUBJECTS` and load `/members`. Reaching it as an administrator proves the mail path, the session cookie and the admin grant together; a 404 there means the group row is missing, and a page without the admin controls means the container predates the `ADMIN_SUBJECTS` edit (`up -d` recreates it).

From here on, updates are [`deploy/deploy.sh`](#deploydeploysh).

## Host configuration (`deploy/deploy.env`)

Where a deployment sits is configuration; what it is, is not. Seven values name a machine, and each has a default, so a host that takes the defaults needs no file at all:

| Variable               | Default                            | Read by                                                           |
| ---------------------- | ---------------------------------- | ----------------------------------------------------------------- |
| `LOREM_SECRETS_DIR`    | `/data/secrets/lorem-host`         | the four `env_file` keys, `deploy.sh`'s config check, `backup.sh` |
| `LOREM_BIND_ADDR`      | `127.0.0.1`                        | the app's `ports:`, and `deploy.sh`'s probe                       |
| `LOREM_HOST_PORT`      | `5880`                             | as above                                                          |
| `LOREM_HEALTH_TIMEOUT` | `120`                              | `deploy.sh`                                                       |
| `COMPOSE_PROJECT_NAME` | `lorem-host`                       | the project, and all three `container_name`s                      |
| `LOREM_BACKUP_DIR`     | `/var/backups/lorem-host`          | the backup service's bind mount, and `backup.sh`                  |
| `LOREM_BACKUP_LOCK`    | `/var/lock/lorem-host-backup.lock` | `backup.sh`                                                       |

- **`LOREM_SECRETS_DIR`** holds `.env` (the app), `postgres.env` (the database) and `backup.env`. Without it set, all three scripts and compose read the default, so moving it in one place and not the others is impossible.
- **`LOREM_BIND_ADDR`** is what the app container publishes on. Loopback because the reverse proxy is the only intended way in: `0.0.0.0` puts Node on the public interface, past every header and TLS setting the proxy applies.
- **`LOREM_HOST_PORT`** is the published port. `deploy.sh` probes health on it, so a second stack that moves the port without setting this probes the first stack and reports itself healthy.
- **`LOREM_HEALTH_TIMEOUT`** is how many seconds `deploy.sh` waits for `/healthz` before it prints the logs and exits 7.
- **`COMPOSE_PROJECT_NAME`** names the project, the network, both volumes and the three containers. Changing it on a running host points the stack at new, empty volumes.
- **`LOREM_BACKUP_DIR`** is where a dump waits between `pg_dump` and the remote confirming it. Root-owned `0700`; `backup.sh` creates it.
- **`LOREM_BACKUP_LOCK`** is the `flock` file that stops two backup runs overlapping.

Copy `deploy/deploy.env.example` to `deploy/deploy.env` and uncomment what differs. **The file is gitignored on purpose**: `deploy.sh` refuses a dirty work tree, so a tracked edit, or an untracked `deploy/deploy.env` the ignore rule missed, fails every deploy with `The work tree has uncommitted changes`.

`SKIN_DIR` is not a host fact and does not go here. It names the site, so it lives in the secrets `.env` with the site's other values (step 4 of [first install](#first-install)), and compose substitutes it into the `skin` build context of the `lorem-host`, `migrate` and `prune` images. A value here still works, because this file is handed to compose last and wins, but nothing in these pages puts one here.

`deploy.sh`, `bootstrap.sh`, `backup.sh` and `run.sh` source it before their own constants. `deploy.sh` and `run.sh` also hand it to compose as `--env-file`, after the secrets file so the host facts win, because their compose calls go through sudo and sudo drops exported variables. Secrets themselves are never in here.

**A compose command typed by hand reads neither file on its own.** Compose reads `.env` in the project directory, and an exported variable does not survive sudo. So every manual command names both, in `deploy.sh`'s order: the secrets `.env` first, then `deploy/deploy.env`, so the host facts win. A build that names only `deploy/deploy.env` misses `SKIN_DIR` and compiles core's default skin. Define the command once per shell, from core's checkout:

```bash
set -a; . deploy/deploy.env; set +a
dc() { sudo docker compose --env-file "${LOREM_SECRETS_DIR:-/data/secrets/lorem-host}/.env" --env-file deploy/deploy.env "$@"; }
dc ps
```

`set -a` exports `LOREM_SECRETS_DIR`, so `dc` names this host's secrets file rather than the default, which on a host running a second stack is production's. A sequence that runs in a root shell defines the same function without the `sudo`. That is why first install copies the example even on a host that takes every default: the flag needs the file to exist.

`COMPOSE_PROJECT_NAME` outranks the `name:` key in `docker-compose.yml`, which is what lets a second stack run beside production on one daemon. Give the second stack its own checkout and its own `deploy/deploy.env`:

```dotenv
LOREM_SECRETS_DIR=/srv/stage/secrets
LOREM_HOST_PORT=5999
COMPOSE_PROJECT_NAME=stage
```

## `deploy/deploy.sh`

Run it on the host, from the checkout:

```bash
deploy/deploy.sh              # interactive: shows the plan, asks, then deploys
deploy/deploy.sh --dry-run    # plan only, changes nothing
deploy/deploy.sh --yes        # automation; implied when stdin is not a TTY
deploy/deploy.sh --rollback   # back to the commit it last replaced
```

| Option            | Meaning                                                                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `-y`, `--yes`     | Do not prompt. Implied when stdin is not a TTY, which is how the CI deploy runs it.                                                                                                                                                         |
| `-n`, `--dry-run` | Print the plan and exit without changing anything.                                                                                                                                                                                          |
| `--ref REF`       | Deploy `REF` instead of `origin/main`. `REF` must still be reachable from `origin/main`, so it went through review; this picks an older reviewed commit, never an unmerged branch.                                                          |
| `--rollback`      | Redeploy the commit this script last replaced. Code only: see below.                                                                                                                                                                        |
| `--no-migrate`    | Skip the migration step. Only when the schema is known current: nothing gates the deploy on it, and `ensureSchema` at boot logs a failure and serves anyway.                                                                                |
| `--no-verify`     | Skip the checks after the health wait: the build-commit comparison and the gate assertion in both directions. The deploy then exits 0 on a healthy container that may be the previous image or serving with the gate open. Not recommended. |
| `-q`, `--quiet`   | Print warnings and errors only.                                                                                                                                                                                                             |
| `--no-color`      | Disable color. `NO_COLOR` set to any value does the same.                                                                                                                                                                                   |
| `-h`, `--help`    | Print usage and the exit codes, then exit 0.                                                                                                                                                                                                |

It fetches, refuses anything not reachable from `origin/main`, fast-forwards, validates the secrets file, runs the migration step, rebuilds, waits for health, then checks the site is in the state the configuration asked for. Everything that can fail without touching the running site fails first, so a deploy that dies before the migration has changed nothing a visitor could notice.

What it checks before touching anything:

| Check                                               | Why it fails the deploy                                                                                   |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Not root; `git`, `docker`, `curl` present           | Root leaves root-owned files in the work tree                                                             |
| Clean work tree, on `main`                          | Fast-forwarding over a host edit either fails or discards it silently                                     |
| Target reachable from `origin/main`                 | The only evidence available on the host that a pull request merged it                                     |
| Checkout is an ancestor of the target               | A fast-forward to an older commit succeeds without moving, and would build the local tree under its stamp |
| `SITE_GATE` is `off`/`password`, and has a password | The app throws on anything else, so the container would restart-loop                                      |
| `ORIGIN`, `PUBLIC_BASE_DOMAIN` non-empty            | A missing `ORIGIN` fails every form action while pages keep loading                                       |
| Secrets file readable, and its mode                 | `env_file` failing open means a container with no configuration                                           |
| `postgres.env` readable, and carries all three keys | The credentials are written twice by design; a gap starts a database the app cannot authenticate against  |
| `docker compose config` validates                   | Cheaper than finding out during `up`                                                                      |

After the restart it asserts the gate matches the configuration in both directions: `SITE_GATE=password` must serve the password form, and `SITE_GATE` off must not. It also compares the two values the running container reports with the ones it built: the commit (`LOREM_BUILD_SHA`) and core's release tag (`CORE_TAG`, empty when core's commit carries none). A container that reports no commit fails the check, as does either value differing; `--no-verify` skips both. The landing page footer shows both.

It does **not** run `pnpm check`, `pnpm test` or `pnpm build`, since the host is not assumed to carry Node or pnpm. That gate belongs in CI; reachability from `origin/main` is what stands in for it on the host.

Exit codes: `1` usage, `2` precondition, `3` fetch or auth, `4` config, `5` migration, `6` build or start, `7` verification.

**When a deploy updates `deploy/deploy.sh` itself, run it twice.** Bash parsed the function bodies before the fast-forward replaced the file, so that run executes the previous version. The script says so on the way out (`re-run deploy/deploy.sh: it updated itself this run`). It runs from a copy in `/tmp`, because bash reads a script by byte offset and rewriting the file underneath a running process lands later reads in the middle of a different line.

`--rollback` returns the code to the commit it last replaced, recorded under `.git/lorem-deploy/` the moment a deploy moves the work tree. A run that moves nothing, such as the CI wrapper's second pass or a retry after a failed deploy, leaves the record alone, so rollback still reaches the release before the one that moved. A deploy that fails after the move has already recorded it. A `--ref` behind the checkout is refused; going back is `--rollback`'s job. **It does not roll back the schema.** When a range contains changes to `src/lib/server/migrations.ts`, the plan says so before you confirm.

`deploy.sh` never touches nginx. A change to your server block is installed by hand, and the last line is the one that proves it landed: `nginx -t` checks that the configuration parses, not that your change is in it.

```bash
sudo cp <your server block> /etc/nginx/sites-available/community.conf
sudo nginx -t && sudo systemctl reload nginx
sudo diff -q /etc/nginx/sites-available/community.conf <your server block>
```

## Pinned layout

A community that keeps its skin in its own repository pins core inside it as a git submodule at `core`, always on a release tag. The host then checks out the site's repository, and `deploy.sh`, which lives in core, deploys the repository above it.

**Clone with the submodule.** A plain clone leaves `core` empty, and `deploy.sh` is inside it:

```bash
git clone --recurse-submodules git@github.com:<owner>/<site>.git /srv/community/www
cd /srv/community/www/core
cp deploy/deploy.env.example deploy/deploy.env
```

While core's repository is private, the host needs a second read-only deploy key, for core, under its own `Host` alias (step 2 of [first install](#first-install) says why a deploy key binds to one repository). `--recurse-submodules` would fetch core with the site's key and be refused, so clone in two steps and point the submodule at the alias before its first fetch:

```bash
git clone git@github.com:<owner>/<site>.git /srv/community/www
cd /srv/community/www
git config submodule.core.url git@github-core:<owner>/<core>.git
git submodule update --init
```

Core's `.gitignore` covers `deploy/deploy.env`, so the copy leaves the site's work tree clean.

**Point `SKIN_DIR` at the site**, in the secrets `.env`. It is relative to core's checkout, so a skin at the root of the site's repository is `SKIN_DIR=..`. `deploy.sh` refuses a pinned deploy with `SKIN_DIR` unset, since the build would otherwise succeed with core's default skin.

**Run it from core:** `core/deploy/deploy.sh`, with the same options. At the top it says which layout it found (`layout: pinned, deploying /srv/community/www with core at core`), and then:

- It fetches the site's `origin`, and core's with its tags, then checks the site's and core's work trees are clean, on `main`, that the target is reachable from the site's `origin/main`, and that the checkout holds no commit the target lacks, so the pin check and the stamp describe the tree that builds.
- It refuses a target whose `core` is not a `v{major}.{minor}.{patch}` tag, naming the commit and the nearest tag, before anything moves.
- After the site's fast-forward it runs `git submodule update --init` and checks that core's checked-out commit is the one the site's commit records. A mismatch stops the deploy before the migration and the build, with the site's checkout at the new commit and core at the old one. The next run recognizes that state from the record it left in `.git/lorem-deploy/core-transition`, and only that state: a re-run finishes the sync, a deploy to a newer commit keeps the release that was running as the one to roll back to, and `--rollback` returns both. Any other change to the tree, including core moved by hand, an edit inside core or a staged `core` entry, is refused as a dirty tree. The clean-tree check overrides `submodule.<name>.ignore`, `diff.ignoreSubmodules` and `status.showUntrackedFiles`, so a setting that hides an edit from a plain `git status` does not let that edit reach the build.
  A file marked `assume-unchanged` or `skip-worktree` in either repository is refused outright, listed by path, because git stops checking its contents.
  `deploy.sh` leaves the bit alone: clear it with `git update-index --no-assume-unchanged --no-skip-worktree <path>`, look at what it was hiding, and re-run.
- `core-transition` is written before the site's commit moves, naming the target, core's starting commit, the release to roll back to and the commit being replaced.
  An interrupt before the move leaves the site where it was and `prior-commit` untouched.
  When the run started from an unfinished transition, the record it replaces is kept as `core-transition.accepted`, so an interrupt before the new move still leaves the old drift recognized: `--rollback` and a retry both proceed from it, with the same predecessor, however many times that repeats.
  An interrupt after it leaves a record the next run reads: a retry at the same target or a deploy to a newer one keeps the release the site was running as the predecessor, and `--rollback` returns to it even when the interrupted run never wrote `prior-commit`.
  The standalone layout writes the same record.
- The migration warning compares core's `src/lib/server/migrations.ts` across the two core commits the deploy moves between: the one checked out when the run started and the one the target records. After a stopped sync those differ even when the site's commit does not move, and the warning still fires. A file at that path in the site's own tree is not core's schema.
- The image is stamped with the site's commit as `LOREM_BUILD_SHA` and core's tag as `CORE_TAG`.
- When core moves, during this run, to a commit whose `deploy/deploy.sh` differs from the one the run started from, it warns that this run was the previous version, and the CI wrapper runs it a second time. That second pass starts from the new core and stays quiet.
- `--rollback` checks out the site's previous commit and the core it records, including after the CI wrapper's second pass.

**Moving the pin** is a commit in the site's repository, reviewed like any other:

```bash
cd core && git fetch --tags && git checkout v1.4.0 && cd ..
git add core
git commit --message 'core v1.4.0'
```

Read [upgrading](upgrading.md) for the releases in between before you merge it. The next deploy moves the host.

**The backup unit** runs core's `deploy/backup.sh`, so `WorkingDirectory=` and `ExecStart=` name the `core` directory: `/srv/community/www/core` and `/srv/community/www/core/deploy/backup.sh`.

## CI deploys

A site deploys from its own repository, not from core: core's `.github/workflows/ci.yml` tests and has no deploy job. The site repository's `.github/workflows/ci.yml` ([skin repository](skin-repository.md#ci-workflow)) validates the skin, builds and runs core's tests on every push to `main` and every pull request. On a push to `main` that passes, a second job connects to the host over SSH and runs `deploy/deploy.sh`, so the test gate the host cannot run has run before the deploy starts.

Three repository secrets are required and one is optional. The deploy job **skips and stays green** when any of the three is missing, so a fork nobody has wired up does not carry a permanently red check:

| Secret               | Value                                                                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `DEPLOY_SSH_KEY`     | Required. Private half of a key made for this.                                                                        |
| `DEPLOY_HOST`        | Required. The host to reach, for example `www.example.org`.                                                           |
| `DEPLOY_KNOWN_HOSTS` | Required. Output of `ssh-keyscan -t ed25519 <host>`.                                                                  |
| `DEPLOY_USER`        | Optional, default `deploy`. The account that owns the checkout. Unset, the job still deploys, connecting as `deploy`. |

**The key is constrained on the host, not in the workflow.** Give it a forced command in `~/.ssh/authorized_keys`:

```text
command="/srv/community/www/deploy/deploy.sh --yes",no-port-forwarding,no-agent-forwarding,no-pty,no-X11-forwarding ssh-ed25519 AAAA... ci deploy
```

A key restricted this way cannot open a shell, forward a port or run anything else, so the worst a leaked `DEPLOY_SSH_KEY` buys is a deploy of `main`. The workflow sends no command of its own: one would be ignored, and writing it down would put the policy in two places where only the host's copy is enforced.

`DEPLOY_KNOWN_HOSTS` is not optional and not replaceable with `StrictHostKeyChecking=accept-new`. Every runner is a fresh machine, so trust-on-first-use there trusts whatever answers the first attempt.

A merge carrying a migration that needs the app stopped fails at the migrate step with the old container still serving; run the [migrations](#migrations) sequence on the host by hand, then let the next merge deploy normally.

The workflow's actions are pinned to commit SHAs rather than tags like `@v7`, because a tag is a pointer its publisher can move.

## Deploy account

A dedicated account, here `deploy`, so the log tells an automated deploy from a person at a terminal. It owns the checkout, holds its own fetch key, and borrows root for a short list of commands.

**It owns the checkout.** `deploy.sh` fast-forwards and writes `.git/lorem-deploy/prior-commit`, so the checkout is owned by the account. Leave its parent `root:root`: nothing in the deploy writes there, and a root-owned parent means the deploy identity cannot create siblings or swap out the checkout wholesale.

**One checkout has one owner.** After the change of owner, a person running `deploy/deploy.sh` directly gets `error: <checkout> is not a git checkout`, which names the wrong cause: git's dubious-ownership guard refuses the repository, and the script reports the refusal as absence. Deploy by hand as the owner instead:

```bash
sudo -u deploy -H deploy/deploy.sh --dry-run
```

**It has its own fetch credential**, a second read-only deploy key in its own `~/.ssh/config`. A repository accepts many deploy keys.

**It has a scoped sudoers drop-in** covering the commands `deploy.sh` borrows root for and nothing else. With the default secrets directory:

```text
(root) NOPASSWD: /usr/bin/docker,
                 /usr/bin/test -r /data/secrets/lorem-host/{.env,postgres.env},
                 /usr/bin/cat /data/secrets/lorem-host/.env,
                 /usr/bin/grep -qE * /data/secrets/lorem-host/postgres.env,
                 /usr/bin/stat {-c %a,-f %Lp} /data/secrets/lorem-host/.env,
                 /usr/bin/true
```

Changing `LOREM_SECRETS_DIR` means changing those paths with it. Validate with `visudo -c -f` **before** installing; a rejected sudoers file locks everyone out.

**Docker access is root access.** `docker run -v /:/host` reads and writes the whole filesystem. Pinning `cat` and `stat` to two paths while granting `docker` in full does not contain someone who reaches this account; it records what the deploy needs. The containment that matters is the forced command on the key.

## Key rotation

A host holds up to four credentials, and each one is replaced the same way: put the new one in place, prove it, then remove the old one.

| Credential        | Lives in                                                 | Grants                                     |
| ----------------- | -------------------------------------------------------- | ------------------------------------------ |
| Site deploy key   | the deploy account's `~/.ssh/`, a deploy key on the site | read the site repository                   |
| Core deploy key   | the same `~/.ssh/`, under `Host github-core`             | read core while it is private              |
| `DEPLOY_SSH_KEY`  | a site repository secret, and `authorized_keys` on host  | run `deploy.sh --yes` on the host, no more |
| `CORE_READ_TOKEN` | a site repository secret                                 | CI's checkout of the site and core         |

**Routine rotation keeps the deploy working throughout.** A repository accepts several deploy keys and `authorized_keys` several lines, so the old and new keys overlap:

1. Make the new keypair beside the old one: `ssh-keygen -t ed25519 -f ~/.ssh/community-deploy.new -N '' -C "$(hostname) deploy $(date +%F)"`.
2. Register the `.pub` as a deploy key with **write access off**: `gh repo deploy-key add ~/.ssh/community-deploy.new.pub --repo <owner>/<site> --title "$(hostname) $(date +%F)"`.
3. Move the new file into place and prove it the way [first install](#first-install) does: `ssh -o BatchMode=yes -T git@github.com` names the repository, and `git push --dry-run` is refused.
4. Remove the old key: `gh repo deploy-key list --repo <owner>/<site>` gives its id, then `gh repo deploy-key delete <id> --repo <owner>/<site>`.

The core key is the same four steps against core's repository and the `github-core` alias, proven with `git -C core fetch --dry-run`. For `DEPLOY_SSH_KEY`, add the new public half to `authorized_keys` with the same forced command, set the secret with `gh secret set DEPLOY_SSH_KEY --repo <owner>/<site> < key`, push a change to `main` or re-run the last deploy job, and delete the old `authorized_keys` line once that run deploys. `CORE_READ_TOKEN` is a fine-grained token with Contents read on core and the site ([skin repository](skin-repository.md) says why both); make the new one, set the secret, re-run CI, then revoke the old token in GitHub's settings.

**A leaked key is removed first.** Delete the deploy key, the `authorized_keys` line or the token before making its replacement, and accept that deploys stop until the new one is in. The overlap that keeps a routine rotation smooth is a window for whoever holds the leaked one. Then check what it could have reached: a read-only deploy key reads the repository, so assume its contents are known; a leaked `DEPLOY_SSH_KEY` could only redeploy `main`, so compare the checkout's `git reflog` on the host with the deploy runs in GitHub Actions.

## Migrations

The migration step gates the deploy and runs **before** the app starts. Postgres publishes no port, so the runner has to sit on the compose network: that is the `migrate` profile in `docker-compose.yml`.

```bash
git pull &&
dc --profile migrate run --build --rm migrate &&
dc up -d --build
```

The `&&` is the gate: a migrate step that exits non-zero ends the chain before `up`, and the app already serving keeps serving the schema it was built for.

**`--build` on the migrate step is doing real work.** `run` reuses whatever image exists, and `up --build` rebuilds only the app, so without it the migrate image sits at whatever commit it was last built from. It then applies the migrations it knows about, reports success, and `ensureSchema` applies the rest when the app boots, so the gate passes while the work happened somewhere else. It stays wrong silently until the ledger runs ahead of the stale image, at which point that image's own consistency check fails the deploy with `ledger has N rows but N-1 migrations are defined`.

`dc` is the function from [host configuration](#host-configuration-deploydeployenv). `deploy/deploy.sh` runs that sequence with the checks around it. The three commands are what to fall back on when the script itself is the problem.

**Migration 13 needs the app stopped.** So do 15 and 16. Each changes what a running app reads: 13 moves member values between `data` and `private_data`, 15 drops columns an older app selects by name, 16 drops the two document columns. While any of them is pending, `scripts/migrate.ts` refuses to apply anything unless `LOREM_WRITERS_STOPPED` names the target database and no other client is connected to it, and it says which of the two failed. A database with no `schema_migrations` table yet has never served an app and is exempt, so a first install migrates with no stop. A database at migration 9 applies 10 through 13, and on through 16, together in one transaction. Take a dump first (see [backups](operations.md#backups)); it is the only rollback. Then, on the host and by hand:

```bash
git pull --ff-only
sudo -s                                    # a root shell: no sudo left to reset the environment
set -a && . deploy/deploy.env && set +a &&
dc() { docker compose --env-file "${LOREM_SECRETS_DIR:-/data/secrets/lorem-host}/.env" --env-file deploy/deploy.env "$@"; } &&
dc build &&
dc stop lorem-host &&
dc --profile migrate run --build --rm -e LOREM_WRITERS_STOPPED=lorem migrate &&
dc up -d ||
{ echo 'release stopped at the step above' >&2; false; }
exit
```

The commands from `set -a` to `up -d` are one `&&` chain, so the first failure ends it and nothing after it runs, pasted or not. A failed build stops before the app does, with the old app still serving. A failed migration leaves the app stopped and the new image unstarted, which is the only safe state for a schema that did not change. `exit` leaves the root shell with the chain's status.

Stopping the app is required on every path, not a choice between an outage and a risk. `LOREM_WRITERS_STOPPED` names the database whose writers you stopped (`lorem` unless `POSTGRES_DATABASE` says otherwise). The CI deploy runs `deploy/deploy.sh`, which neither stops the app nor sets the variable, so a merge that reaches it fails at the migrate step with the old container still serving and the schema untouched: stop the app and run the sequence above instead. A failed run aborts in its own transaction and changes nothing; `sudo docker compose --env-file deploy/deploy.env start lorem-host` brings the old app back. Migration 13 refuses, changing nothing, on a database whose rows are still keyed by spreadsheet headings.

**Rehearse it first.** Restore last night's dump into a scratch database, `restore_check`, with steps 1 to 3 of [restoring](operations.md#restoring), then run the gated migration against it:

```bash
dc --profile migrate run --rm --build \
  -e POSTGRES_DATABASE=restore_check -e LOREM_WRITERS_STOPPED=restore_check migrate
```

It prints the versions it applied and asserts the ledger matches the tree. A failure here costs nothing; the same failure on production costs the stop.

**Migration 15 needs the app stopped too.** An app built before it selects `group.sheet_id` and `member.source_row` by name, so it answers 500 on every group page from the moment the migration commits. `deploy/deploy.sh` migrates before it builds the replacement, and a build that then failed would leave the old container serving that schema with nothing to replace it. The release goes out on the host and by hand:

```bash
git pull --ff-only
sudo -s                                    # a root shell: no sudo left to reset the environment
set -a && . deploy/deploy.env && set +a &&
dc() { docker compose --env-file "${LOREM_SECRETS_DIR:-/data/secrets/lorem-host}/.env" --env-file deploy/deploy.env "$@"; } &&
dc build &&
dc stop lorem-host &&
dc --profile migrate run --build --rm -e LOREM_WRITERS_STOPPED=lorem migrate &&
dc up -d ||
{ echo 'release stopped at the step above' >&2; false; }
exit
```

As above, the commands from `set -a` to `up -d` are one `&&` chain, so the first failure ends it and nothing after it runs, pasted or not. A failed build stops before the app does, with the old app still serving. A failed migration leaves the app stopped and the new image unstarted, which is the only safe state for a schema that did not change. `exit` leaves the root shell with the chain's status.

`deploy/deploy.sh --no-migrate` is not a way around the stop: it leaves the drop to `ensureSchema` at boot, which logs a failure and serves anyway, so nothing gates the deploy and nothing reports the ledger. `pnpm seed` migrates before it seeds, so it refuses on the same terms, `deploy/run.sh seed` included. Once it commits the drop is not reversible, and `deploy/deploy.sh --rollback` would start an app that selects columns that are gone. The dump taken before the deploy is the only way back to them.

**`profiles:` keeps the migrate service out of a plain `docker compose up`.** It builds the `build` stage of the same `Dockerfile`, the one with the dev dependencies and `tsx`, off the same lockfile the app image is built from, and bind-mounts `scripts/` read-only, because no image stage ships it. Running `pnpm migrate` from a checkout on the host is not a fallback: the name `postgres` resolves on the compose network and nowhere else.

The app also calls `ensureSchema()` at module load, and both paths drive the same advisory-locked, transactional engine (`src/lib/server/migrations.ts`). After the deploy step, that boot call finds nothing pending and is a no-op. The deploy step is the half that gates: it prints the versions it applied, asserts the `schema_migrations` ledger matches the migrations compiled into the tree, and exits non-zero on either failure. `ensureSchema` logs `schema.migrate.error` and lets the server come up on a stale schema. It stays anyway: `restart: unless-stopped` restarts this container on a host reboot, on the memory limit, and on every `docker compose up -d`, so dropping it would turn one skipped deploy step into a schema that is silently behind the code.

**Point the migrate step at a direct, unpooled endpoint.** `migrate()` takes a session-scoped `pg_advisory_lock` on a pooled client and releases it in a `finally`. A transaction-pooling endpoint (PgBouncer, a Neon `-pooler` host) can route that release to a different backend than the one holding the lock, leaving it held until that backend's session ends. The `postgres` service has no pooler in the path; this constrains where the database may move.

## Moving hosts

A move is [first install](#first-install) with the database restored instead of migrated, and DNS moved last. Nothing in the tree needs editing: the paths and names that differ live in [`deploy/deploy.env`](#host-configuration-deploydeployenv).

**One writer at a time.** The old app stops before the final dump and stays stopped. Every profile edit, approval or import the old app accepted after the dump would be missing from the new database, and an old app still serving after DNS moves is a second database taking writes that nothing will ever merge. The cost is an outage of one dump, one copy, one restore and one container start; the DNS propagation that follows is not part of it if the old proxy forwards (step 6).

1. **Stand the new host up to step 6 of first install, and stop there.** Copy `deploy/deploy.env` and write the secrets files, including `ADMIN_SUBJECTS`, but do **not** run the migrate step, create the group row or start the app: the restore brings the schema, the group and its members.
2. **Get certificates onto the new host before the freeze.** The real names still resolve to the old host, so the http-01 challenge `certonly --nginx` answers in first install cannot validate them here. Use a DNS-01 challenge (`certbot certonly --manual --preferred-challenges dns`, or your DNS provider's certbot plugin) to issue for the real names now, and lower the records' TTL to a few minutes a day ahead. The alternative is to issue with http-01 after step 6, which leaves the new host serving without a valid certificate until it completes.
3. **Freeze deploys on both hosts.** A stopped app is not a stopped writer while a deploy can still run `up -d`, so this step has two halves and both finish before step 4. The same freeze opens [rolling back](#moving-hosts) when the new app has run.
   - **Block new deploys.** Run `gh workflow disable ci.yml`, so no new run is admitted, and comment out the CI key's line in `authorized_keys` on the old host and on the new one if it has it, so a run already queued cannot connect. Pointing `DEPLOY_HOST` at the other host is not a block: it sends the next deploy to a host that is part of the move.
   - **Drain deploys already admitted.** Removing a key does not end an SSH session that has already authenticated, and the deploy job never cancels in progress, so a deploy admitted before the block can still finish with `up -d`. Wait for every running deploy on each host to finish on its own; do not cancel or kill one. A canceled or failed CI run, or a dropped SSH session, says nothing about the host: `deploy/deploy.sh` re-executes itself from an unlinked copy named `lorem-deploy.<random>` under `$TMPDIR`, so its command line no longer names `deploy/deploy.sh`, and a `docker compose` it started can outlive it. Killing the script can leave that compose child running `up -d`. On each host, run this until it prints nothing:

     ```bash
     pgrep -af 'lorem-deploy\.|deploy/deploy\.sh|docker[- ]compose'
     ```

     It matches the launcher, the snapshot it became and every compose client, whoever started it. The freeze holds once it prints nothing on both hosts and `gh run list --workflow ci.yml --status in_progress` and `--status queued` print nothing. A deploy that never finishes is a stuck deploy to investigate on that host, not one to declare drained.

   Deploys stay blocked through the restore, the migration, the rebuild and the DNS move. Step 8 re-enables them on the new host alone, and CI checks on pull requests stay off until then.

4. **Freeze the old writer**, on the old host. An old host without a `deploy/deploy.env` copies the example first:

   ```bash
   cd /srv/community/www
   sudo -s                                    # a root shell: no sudo left to reset the environment
   set -a; . deploy/deploy.env; set +a        # the host facts, exported for compose
   docker compose stop lorem-host
   exit
   ```

   From here the old proxy answers 502 for the app, which is the correct answer: nothing can write. Postgres keeps running so the dump can reach it. `restart: unless-stopped` does not bring a stopped container back after a reboot.

5. **Take the final dump** on the old host, and see it on the remote:

   ```bash
   sudo deploy/backup.sh
   sudo deploy/backup.sh --list
   ```

   This is the only dump the move restores. The nightly one is older than the freeze by up to a day of writes.

6. **Restore on the new host**, following steps 1 to 4 of [restoring](operations.md#restoring): fetch, place and check the dump, then run step 4's chain against `$POSTGRES_DB`. On the new host no app container exists yet, so its `stop` has nothing to stop and its final `dc up -d --build lorem-host` builds and creates the app, only after the restore and the migrate step have both succeeded.

   `pg_restore` brings `schema_migrations` with the data, so the migrate step applies only what the new checkout has beyond the old one and asserts the ledger. If it names a migration that needs writers stopped, add `-e LOREM_WRITERS_STOPPED=lorem`: no app is running anywhere, so that is true. To cover propagation, point the old host's server block at the new one (`proxy_pass https://<new host address>;` with `proxy_ssl_name` set to the real name), so a client still resolving the old address reaches the one writer instead of a 502.

7. **Prove it before moving DNS.** A restore that produced an empty `member` table looks healthy from `/healthz` and from `compose ps`, so sign in and load the directory, reaching the new host by its address:

   ```bash
   curl -sI --resolve www.example.org:443:<new host address> https://www.example.org/healthz   # 200
   sudo docker compose --env-file deploy/deploy.env ps                                         # three services, healthy
   ```

8. **Move DNS, then re-enable deploys on the new host only.** The old app stays stopped until decommissioning; requests that still reach the old address get the forward from step 6 or a 502, never a second writer. Set `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS` to the new host, restore the CI key's line in the new host's `authorized_keys`, and run `gh workflow enable ci.yml`. The old host's key line stays commented out.
9. **Move the backup timer**, then decommission the old host. Install the systemd units on the new host, run `sudo systemctl start community-backup.service` by hand, and confirm with `deploy/backup.sh --check`. Disable the old host's timer so two hosts do not write to one remote. A move that leaves the timer behind produces a site with no dumps and nothing saying so, until the absence alert fires a day later.

**Rolling back** depends on whether the new app could have accepted writes, never on where DNS points. Step 6 forwards the old address to the new app and step 7 signs in to it, so the new database can take writes while DNS still names the old host. Exactly one of these two cases applies:

- **The new app was never started.** The move failed at or before step 6's migrate step, and no `up` ran on the new host, so nothing has written anywhere since the freeze. Step 3's freeze is still in place. Remove any forward from the old host's server block and start the old app on the old host with `sudo docker compose --env-file deploy/deploy.env start lorem-host`. Then re-enable deploys toward the old host alone: restore the CI key's line in its `authorized_keys` and run `gh workflow enable ci.yml`.
- **The new app was started, even once.** Treat it as holding accepted writes the old database lacks. First repeat step 3's freeze against both hosts: block new deploys with `gh workflow disable ci.yml` and the CI key's line commented out in `authorized_keys` on the new host as well as the old, then wait for every running deploy job on the new host to finish on its own, until step 3's `pgrep -af 'lorem-deploy\.|deploy/deploy\.sh|docker[- ]compose'` prints nothing there; a canceled CI run is not a finished deploy. If step 8 ran, deploys are live on the new host and one admitted after the stop would start it again with `up -d`. Then stop the new app, on the new host, with `sudo docker compose --env-file deploy/deploy.env stop lorem-host`: from here until the old app starts every request answers 502, and no moment has two writers. Take the new host's final dump with `sudo deploy/backup.sh`, after giving it a `backup.env` as in [backups](operations.md#backups) if step 9 has not run. On the old host, check out the commit the new host runs, since the dump's `schema_migrations` came from it and an older tree refuses that ledger, then restore the dump with steps 1 to 4 of [restoring](operations.md#restoring). That chain ends by rebuilding the old host's app from the checked-out commit and recreating its container, so the code serving the restored database is the code whose migrations it carries; the container the freeze stopped was built from the older commit and is never resumed. Only once the chain has succeeded do you route traffic back: remove the old host's forward, move DNS back if step 8 ran, and point the new host's server block at the old one while the change propagates. Only then re-enable deploys, toward the old host alone: `DEPLOY_HOST` and `DEPLOY_KNOWN_HOSTS` back to it if step 8 changed them, its CI key line restored, then `gh workflow enable ci.yml`. The new host's key line stays commented out, and the new app stays stopped until the new host is torn down or the move is retried from step 3.
