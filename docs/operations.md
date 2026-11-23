# Operations

Running a deployed site: scripts on the host, backups and restore, how the containers are fenced off, and what the reverse proxy and the app each contribute to the response headers. The examples use `www.example.org`, a checkout at `/srv/community/www` and the default secrets directory `/data/secrets/lorem-host` (`$LOREM_SECRETS_DIR`).

## Running scripts on a host

`export-members`, `import-members`, `prune-audit` and the rest are `tsx`, and a deploy host is not assumed to carry Node or pnpm. `deploy/run.sh` runs them through the same compose service migrations use, which already has the build stage of the image, `scripts/` mounted read-only, the secrets file, and a place on the compose network where the name `postgres` resolves:

```bash
deploy/run.sh export-members example > roster.csv
deploy/run.sh import-members example - < roster.csv
deploy/run.sh prune-audit
deploy/run.sh change-member-email old@example.org new@example.org
deploy/run.sh --help          # the list, read off scripts/
```

It reads `deploy/deploy.env` and hands it to compose after the secrets file, the way `deploy/deploy.sh` does, so a host with its own project name, port or secrets directory runs the script against its own stack even though the compose call goes through sudo. It rebuilds the image first, for the reason the migrate step does: `compose run` reuses whatever image exists, so without that a script silently runs against whatever commit the image was last built from. A configuration change applied by stale code is worse than one that fails.

## Member lost both sign-in addresses

A member who changed their sign-in email can undo it from the old address for 7 days, and can always sign in by magic link at the current one. One who has lost access to both (an old employer's mailbox, say, and a new address someone else controls) has no link that reaches them. Confirm who they are by whatever means your community trusts, out of band, then move their account to an address they hold now:

```bash
deploy/run.sh change-member-email old@example.org new@example.org
```

`old@example.org` is the address the account signs in as today. The script moves every group's member row, admin grant and star from it to the new address in one transaction, the same rewrite a member's own change runs, deletes the account's passkeys (whoever holds the lost address may have enrolled one), voids every undo link the account's notices carried and every change link still pending, and records `member.email-changed` audit rows with `operator:change-member-email` as the actor. It refuses, changing nothing, when no member has the old address or when the new one already belongs to a member or an admin. If the account joins a group while the script runs, it stops and says to retry; run it again. No mail is sent: tell the member to sign in by magic link at the new address, and to add a passkey again if they used one.

Sessions under the old address are not deleted, since the script reaches only Postgres. They stop matching any member row or admin grant the moment it commits, so they can see nothing a guest cannot, and they end at their 24-hour lifetime.

## Backups

`postgres-data` is dumped off the box once a day, encrypted to a key the host cannot read. `redis-data` is not, and does not need to be: the last two subsections say why, and what the schedule still leaves exposed. The example destination is a Backblaze B2 bucket named `example-backups`; any `rclone` remote works.

```
what      pg_dump -Fc of the whole database, member_avatar.bytes included
when      daily, 03:15 UTC + up to 15 min of jitter
how       docker compose --profile backup run --rm backup, from a systemd timer
where     an rclone remote, a Backblaze B2 bucket here
crypto    age, to a recipient whose identity is deliberately NOT on this host
keep      30 days
alert     a dead-man's switch, pinged only once this run's dump is confirmed
ceiling   about 31 minutes waiting on a dead destination, 47 in any run
```

**What a dead destination costs a run.** Every `rclone` call, and the heartbeat's `curl`, runs under an elapsed deadline enforced by `timeout`, which kills it, so a destination that never answers cannot hold the timer until `TimeoutStartSec=3600`. The `rclone` flags (`--contimeout`, `--timeout`, `--retries`) alone do not do this: `--timeout` is idle time, and a backend's retry pacer sleeps outside network I/O, so B2 answering `503` with `Retry-After: 600` waits ten minutes with no idle timer running. `curl` has the same gap: `-m` bounds one attempt, and a monitor answering `503` with `Retry-After: 7200` overrides `--retry-delay` and sleeps two hours between attempts. The deadlines, each with 5 seconds' grace for the kill:

```
probe, before pg_dump      20 s    the dump is taken whatever it says
upload, per file          900 s    1.1 GB at 1.3 MB/s, the pessimal dump in "What a dump holds"
size check, listing        60 s
retention delete          120 s
older queued dumps        none started after 600 s of uploading
heartbeat                  60 s    curl, 4 attempts of 15 s, cut off with any Retry-After sleep
```

Each one is read from the environment when set, as a whole number of seconds: `BACKUP_PROBE_DEADLINE`, `BACKUP_UPLOAD_DEADLINE`, `BACKUP_LIST_DEADLINE`, `BACKUP_DELETE_DEADLINE`, `BACKUP_STRAGGLER_BUDGET` and `BACKUP_HEARTBEAT_DEADLINE`.
Any other value stops the run with exit code `3`.
The tests set them to 3 seconds to prove each cutoff fires; a host has no reason to set them.

A destination that is dead from the start costs a run at most about 31 minutes: the probe, one older queued dump's upload (the older ones stop at the first failure) and one upload of this run's own dump, which is attempted whatever happened to the older ones. The worst case for any run is about 47 minutes of waiting: 600 seconds spent shipping older dumps, one more started just before that ran out, this run's own upload and size check, the prune's listing and delete, and the heartbeat. That leaves about 13 minutes of `TimeoutStartSec` for `pg_dump` and `age`. Neither number grows with the length of the queue. Measured in an Ubuntu 24.04 container with its packaged `rclone` 1.60.1, against a loopback B2 endpoint throttling every request with `Retry-After: 600`: `--dry-run` exited `5` after 20 seconds, and a full run stopped at 60 seconds had its encrypted dump staged. A legitimate upload slower than 900 seconds is cut off and retried the next day, which at today's dump sizes (11 MB) takes a link below 13 KB/s.

**Daily, decided against the change rate rather than defaulted.** The roster moves a few rows a week: an hourly dump would be 24 copies a day of a directory that changed once, and every copy is a full copy of every member's postal address, so the cost is exposure as much as storage. Weekly loses a week of avatar uploads, stars, group admins and admin-edited markdown, none of which exists anywhere else. Daily is the setting; the residual window it leaves is the last subsection here.

**No new daemon on the host.** The dump runs in a one-shot container off the `backup` profile in `docker-compose.yml`, on the same terms the `migrate` profile runs migrations and for the same reason: `postgres` publishes no port, so the name resolves on the compose network and nowhere else. `systemd` is already running on the box; the unit is `Type=oneshot` and `systemctl status community-backup` reads `inactive (dead)` between runs.

**The image is pinned to the same tag the server runs** (`postgres:17.4-alpine`). `pg_dump` refuses a server newer than itself, so bumping the `postgres` service without bumping the `backup` service fails the next backup rather than quietly producing something a restore cannot use.

### Where it goes, and what happens when it cannot get there

A Backblaze B2 bucket, reached with `rclone` under an application key scoped to that one bucket, stored in `$LOREM_SECRETS_DIR/rclone.conf` as `root:root 0600`. That key can write and delete inside the bucket and can do nothing else on the account.

Off the box is the requirement, not a nicety. A dump written to the same disk as the volume it protects survives a bad migration and survives nothing else — not a lost disk, not a host that stops booting, not the server going away.

When the destination is unreachable the run still takes a dump, encrypts it, and leaves it in `/var/backups/lorem-host`, then exits non-zero **without** pinging the heartbeat. The next run uploads the older queued dumps oldest-first after taking that day's dump, then its own, and each file is deleted locally only once the remote reports it at the same byte count. The older ones stop at the first that fails and stay queued, but this run's own dump is attempted regardless, so one old file the remote rejects for its own reasons (a name conflict, an object over the remaining quota) cannot stop every later dump from leaving the host. So the staging directory is a retry queue rather than a second copy: a dump that reached B2 is gone from this host within seconds, and one that did not is still here to try again.

A file in that queue is uploaded only if it is non-empty. The script cannot write an empty one itself (`take_dump` and `encrypt` both refuse an empty output before it is queued), so one found there was put by someone or something else; it is left in place with a warning rather than confirmed at `0 == 0` and deleted.

The retention prune refuses to run when nothing on the remote is recent. A run that could not upload is therefore never the run that deletes the history. It deletes only `*.age` objects, the same filter the absence check counts, so an operator's note or a second stream sharing the prefix is outside its reach even though the application key could delete it.

### Encrypted, because B2 is a third party

Say it plainly: the destination is not trusted. A dump of this database on somebody else's storage is the member directory on somebody else's storage, private fields and all. Every object is `age`-encrypted before it leaves, to recipients listed in `BACKUP_AGE_RECIPIENTS`.

**The identity that decrypts them is not on the host being backed up, and must not be.** The host holds public recipients only. Somebody who takes root there can read the live database anyway, so putting the identity beside it would hand them the entire archive as well for no gain. The price is real and worth stating: a restore is a two-machine operation, and losing every copy of the identity loses every backup. Encrypt to **two** recipients — the operator's working identity and an escrow copy kept somewhere neither the box nor the laptop can reach.

`age` rather than GnuPG: one file, one line to encrypt, no keyring to migrate, no agent to be unavailable and no expiry to surprise the person restoring at 03:00.

Nothing on the box can prove the ciphertext is readable, because nothing on the box can decrypt it. `deploy/backup.sh` rejects a malformed recipient at startup, which removes the clumsy half of that failure; a recipient that is well-formed but not yours is caught only by the drill under **Restoring** below. Run it.

### Install

**1. Two packages.** Neither is a service:

```bash
sudo apt-get install -y age rclone
```

**2. The rclone remote**, written as root so the deploying user never holds the bucket key:

```bash
sudo -E rclone config --config /data/secrets/lorem-host/rclone.conf
# n) new remote -> name: b2 -> storage: b2 -> account/key from a bucket-scoped
#    application key
sudo chmod 600 /data/secrets/lorem-host/rclone.conf
```

**3. The recipient.** On a workstation, never on the box:

```bash
age-keygen -o ~/.age/lorem-host-backup.txt   # keep this file; it is the backup
grep 'public key' ~/.age/lorem-host-backup.txt
```

**4. The configuration**, `root:root 0600` beside the other secrets files:

```bash
sudo install -m 600 /dev/null /data/secrets/lorem-host/backup.env
sudo -e /data/secrets/lorem-host/backup.env
```

```dotenv
BACKUP_RCLONE_REMOTE='b2:example-backups/postgres'
BACKUP_AGE_RECIPIENTS='age1operator... age1escrow...'
BACKUP_HEARTBEAT_URL='https://hc-ping.com/<uuid>'
RCLONE_CONFIG='/data/secrets/lorem-host/rclone.conf'
BACKUP_RETENTION_DAYS=30
BACKUP_MAX_AGE_HOURS=26
```

**This file is shell, not a Docker env file.** `deploy/backup.sh` sources it with bash under `set -e`, so every line is a shell assignment: quote any value with a space, `<`, `>`, `&` or `;` in it. An unquoted `BACKUP_AGE_RECIPIENTS=age1... age1...` runs the second recipient as a command, and the backup exits 127 before it dumps anything. Check an edit with `sudo bash -n /data/secrets/lorem-host/backup.env`.

`BACKUP_HEARTBEAT_URL` is required. Without it the script refuses to run, and says why: absence is the alert that matters, and a job that only reports its own errors cannot report never having started. Accepting that nobody is watching takes an explicit `BACKUP_HEARTBEAT_OPTIONAL=true`, which is a sentence someone wrote rather than a default nobody read.

**5. The timer.** `deploy/deploy.sh` does not install it, and warns at the end of every run until an enabled, running `*-backup.timer` triggers a service whose `ExecStart=` is this checkout's `deploy/backup.sh`. The timer's name proves nothing on a shared host, so another application's timer gets a warning that this deployment's coverage cannot be confirmed. `deploy/systemd/example-backup.service` and `example-backup.timer` are an example pair: copy both under one name, because the timer starts the service that shares its name, and keep the copies with your site's files rather than editing core's. The service unit names the checkout twice, in `WorkingDirectory=` and `ExecStart=`, as `/srv/community/www`. Edit both to your checkout after copying (the `core` directory, when the checkout pins core as a submodule), or override them with `sudo systemctl edit community-backup.service`:

```bash
sudo cp deploy/systemd/example-backup.service /etc/systemd/system/community-backup.service
sudo cp deploy/systemd/example-backup.timer /etc/systemd/system/community-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now community-backup.timer
sudo systemctl list-timers community-backup.timer
```

**6. Prove it, now, before you need it:**

```bash
sudo deploy/backup.sh --dry-run    # config + a probe of the remote, no dump
sudo systemctl start community-backup.service
sudo deploy/backup.sh --list       # the object should be there
sudo deploy/backup.sh --check      # exits 0 while a dump is newer than 26h
```

### Images, and what a teardown keeps

Three images carry every part of this, and two of them are already in the tree's orbit for other reasons:

| Image                  | Used by                              | Pinned where                  |
| ---------------------- | ------------------------------------ | ----------------------------- |
| `postgres:17.4-alpine` | the `backup` profile and `postgres`  | `docker-compose.yml`, both    |
| `lorem-host-migrate`   | the `migrate` profile, built locally | `Dockerfile`, `build` stage   |
| `docker:28-cli`        | reproducing this off the host        | nothing; name the tag by hand |

The first two are the deploy path. The third is only for exercising `deploy/backup.sh` somewhere that is not the host: the script wants `docker compose`, `age`, `rclone`, `flock` and GNU `stat` on Linux, and a container holding the host's docker socket is the cheapest way to get all five without installing them on a laptop:

```bash
docker run -d --name lorem-backup-lab \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD:$PWD" -w "$PWD" docker:28-cli sleep infinity
docker exec lorem-backup-lab apk add --no-cache bash age rclone curl coreutils util-linux
```

Mount the checkout at the same absolute path it has on the host. The compose file's bind mounts are resolved by the daemon, not by the client, so a checkout mounted anywhere else sends the daemon a path that does not exist and `--profile backup` fails on a directory it cannot find.

The `env_file:` paths are the opposite: the client reads those, so the lab container needs its own `$LOREM_SECRETS_DIR/.env` and `postgres.env` or `docker compose config` refuses to load the project at all, including the profiles that do not use them. Stand-in files with the fixture credentials are enough. Point `LOREM_BACKUP_DIR` at a directory mounted into the lab at the same absolute path, for the reason above, and the whole path runs against a scratch database with nothing of production in reach.

**Tearing the stack down does not remove any of them.** `docker compose down -v` removes containers, networks and the named volumes; it has no effect on images or on the build cache. So a second run of the drill below re-pulls nothing and rebuilds nothing, and the `pnpm install && pnpm build` inside the `migrate` image is paid once. Confirm before assuming you are about to wait:

```bash
docker image ls --filter reference=postgres:17.4-alpine \
                --filter reference=docker:28-cli \
                --filter 'reference=lorem-host-migrate*'
docker buildx du            # the build cache behind lorem-host-migrate
```

`docker image ls` takes at most one positional name, so the three are asked for as repeated `--filter reference=` terms, which OR together.

What that costs is disk: roughly 1.4 GB of images plus whatever the build cache has grown to, which is measured in tens of gigabytes on a machine that builds often. Reclaiming it is deliberate, never a side effect of a teardown:

```bash
docker image rm lorem-host-migrate
docker buildx prune          # add --all to take the cache the builder still references
```

The rebuild after that is the pnpm install, so reclaim the cache when disk is the problem and not before.

### Alerting on absence, not on failure

The interesting condition is "no successful dump in longer than the interval", because that one condition covers a timer nobody enabled, a job that started failing, an application key that expired and a bucket that filled up. A job that reports only its own errors cannot report never having started, so the alarm lives off this host.

`deploy/backup.sh` pings `BACKUP_HEARTBEAT_URL` as its last act, and reaches it only after `rclone` has confirmed **this run's own dump** present at the byte count it was written with. So the monitor watches today's dump, not the queue: a run that ships a dump left over from an earlier outage but not its own exits `5` without pinging. The monitor is configured to expect that ping daily and to alert when it does not arrive. Anything that stops the pipeline anywhere stops the ping.

`deploy/backup.sh --check` is the same test by hand, and exits `6` when the newest object on the remote is older than `BACKUP_MAX_AGE_HOURS` (26 by default: one day, plus the timer's jitter, plus room for a slow upload). It is what to run first when the monitor pages.

Exit codes: `1` usage, `2` precondition, `3` config, `4` dump, `5` upload, `6` absence.

### Retention

30 days, and it is a privacy decision before it is a storage one: each object is a full copy of the member directory including the postal addresses, phone numbers and sizes, so every extra day of retention is another day a stolen archive is still current. Thirty covers noticing a bad migration or a wrong bulk edit late; it does not accumulate a year of full directory copies to answer a question the change history answers better.

Two consequences to hold on to. A member deleted today is still in up to 30 daily dumps, so an erasure request is only complete 30 days later, and anyone answering one has to say so. And the window is deliberately shorter than the change history's, so a data change discovered after 30 days is repairable from the record of what changed, not by restoring the whole database.

### What the dump contains, and how big it gets

Everything: `pg_dump -Fc` of the whole database, so `member_avatar.bytes` is in there as binary and not as a reference to something else. That column is the largest thing in the volume by a wide margin, and it is the reason to watch the size at all. Measured on a database seeded with 40 members, 30 cached Gravatars and 3 uploads at the app's 2 MB ceiling:

```
avatar bytes in Postgres     9,977,856
pg_dump -Fc output          11,405,405     1.14x
age-encrypted object        11,408,389     +2,984 bytes of header
everything except avatars      ~21,900     the other seven tables, all of them
```

The dump does not shrink the largest thing in it: JPEG and PNG payloads are already compressed, and the custom format's escaping costs about 14% on top. Plan on that multiplier, not on a compression ratio.

So the trajectory is set by avatars alone. At the observed shape — most members on a Gravatar around 120 KB, a minority uploading — 500 members lands near 70 MB a dump and about 2 GB across a 30-day window. The pessimal case is every member uploading at the 2 MB cap: 500 members is then 1.1 GB a dump and 34 GB retained. Both fit a B2 bucket without thought; what does not fit without notice is the upload window on this host's uplink, which is the thing to re-measure if `member_avatar` ever passes a few hundred megabytes.

### Restoring

The identity lives on a workstation, so a restore starts there. Steps 1 to 3 change nothing on the box and are also the quarterly drill: run them against `restore_check` on a normal day, because nothing else can prove the archive is readable.

**1. Fetch and decrypt, on the workstation:**

```bash
rclone lsl b2:example-backups/postgres
rclone copy b2:example-backups/postgres/lorem-host-20260818T031500Z.dump.age .
age -d -i ~/.age/lorem-host-backup.txt \
    -o lorem-host-20260818T031500Z.dump \
    lorem-host-20260818T031500Z.dump.age
```

**2. Put the plaintext where the container can read it.** `/var/backups/lorem-host` is the bind mount the `backup` profile already has, and it is `0700 root:root` for this exact minute:

```bash
scp lorem-host-20260818T031500Z.dump www.example.org:/tmp/restore.dump
ssh www.example.org
sudo install -o root -g root -m 600 /tmp/restore.dump /var/backups/lorem-host/restore.dump
rm -f /tmp/restore.dump
```

**3. Restore into a scratch database and compare it with the live one.** Never straight over production: this is the step that tells you the dump is what you think it is, and it costs one minute.

```bash
cd /srv/community/www
sudo docker compose --env-file deploy/deploy.env --profile backup run --rm backup sh -c '
  set -eu
  export PGPASSWORD="$POSTGRES_PASSWORD"
  dropdb -h postgres -U "$POSTGRES_USER" --if-exists restore_check
  createdb -h postgres -U "$POSTGRES_USER" restore_check
  pg_restore -h postgres -U "$POSTGRES_USER" -d restore_check \
    --no-owner --no-privileges --exit-on-error /dump/restore.dump'
```

Run this against both databases and diff the two outputs. Row counts, one avatar compared by digest, and the migration ledger are what a good restore has to reproduce:

```bash
sudo docker compose --env-file deploy/deploy.env --profile backup run --rm backup sh -c '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  for db in "$POSTGRES_DB" restore_check; do
    echo "== $db"
    psql -h postgres -U "$POSTGRES_USER" -d "$db" -qAt <<"SQL"
SELECT (SELECT count(*) FROM "group")        AS groups,
       (SELECT count(*) FROM member)         AS members,
       (SELECT count(*) FROM group_admin)    AS admins,
       (SELECT count(*) FROM access_request) AS requests,
       (SELECT count(*) FROM member_avatar)  AS avatars,
       (SELECT count(*) FROM member_star)    AS stars,
       (SELECT count(*) FROM audit_event)    AS audit_events,
       (SELECT count(*) FROM member_import_plan) AS import_plans;
SELECT encode(sha256(bytes), $$hex$$) || $$ $$ || octet_length(bytes)
  FROM member_avatar WHERE bytes IS NOT NULL ORDER BY email_md5 LIMIT 1;
SELECT string_agg(version || $$:$$ || name, $$, $$ ORDER BY version)
  FROM schema_migrations;
SQL
  done'
```

The heredoc and the `$$…$$` quoting are not decoration. A double quote is an identifier in SQL, so the obvious `-c "… encode(sha256(bytes),\"hex\") …"` asks Postgres for a column named `hex` and fails, three quoting levels deep, at the moment you least want to debug it.

**4. Only then, cut over.** Stop the app first: `dropdb` fails while it holds connections, and a half-restored database serving traffic is worse than a down one.

```bash
sudo -s                                    # a root shell: no sudo left to reset the environment
cd /srv/community/www &&
set -a && . deploy/deploy.env && set +a &&
dc() { docker compose --env-file "${LOREM_SECRETS_DIR:-/data/secrets/lorem-host}/.env" --env-file deploy/deploy.env "$@"; } &&
dc stop lorem-host &&
dc --profile backup run --rm backup sh -c '
  set -eu
  export PGPASSWORD="$POSTGRES_PASSWORD"
  dropdb -h postgres -U "$POSTGRES_USER" "$POSTGRES_DB"
  createdb -h postgres -U "$POSTGRES_USER" "$POSTGRES_DB"
  pg_restore -h postgres -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --no-owner --no-privileges --exit-on-error /dump/restore.dump' &&
dc --profile migrate run --build --rm migrate &&
dc up -d --build lorem-host ||
{ echo 'restore or migration failed: the app is stopped' >&2; false; }
exit
```

`set -a` exports the host facts in `deploy/deploy.env`, and `dc` hands compose the secrets `.env` and that file in the order `deploy/deploy.sh` does, so the rebuild compiles the skin `SKIN_DIR` names rather than core's default. Every command from `cd` to `up` is one `&&` chain, so the first one that fails ends it, pasted or not, and the app stays stopped. The `set -eu` inside the quotes stops the container's shell and nothing else: without the chain, the host shell runs the next line regardless of the restore's exit status, and a failed `pg_restore` is followed by a migrate step and an app serving a half-loaded database. A failure prints the line above after the command's own error, and `exit` leaves the root shell with the chain's non-zero status; fix the cause, then run the block again from the top, since `dropdb` starts it over. Only after the chain succeeds, check the site:

```bash
curl -sI https://www.example.org/healthz
```

The last step is `up --build`, never `start`. The migrate step runs the checkout's migrations, but `start` resumes the stopped container with the image it was created from, so an app built from an older commit comes back against a schema it cannot read: migration 16 drops two columns that earlier app code still selects. `up -d --build lorem-host` builds the app from this checkout and recreates the container whenever that image differs from the one it runs, so the code serving the restored database is the code whose migrations just ran. On a fresh host, such as the target of a [move](deployment.md#moving-hosts), no app container exists yet: `stop` has nothing to stop and the same `up` creates it.

The migrate step is not redundant. The dump carries the schema as of the moment it was taken; the checkout may be ahead of it, and `schema_migrations` came back in the dump, so the runner applies exactly the difference and asserts the ledger matches the tree. A dump taken before migration 15 makes the runner refuse until you add `-e LOREM_WRITERS_STOPPED=lorem`; the app is already stopped here, so that is the only change.

**5. Delete the plaintext.** It is the whole member directory, unencrypted, on a shared host:

```bash
sudo rm -f /var/backups/lorem-host/restore.dump
sudo docker compose --env-file deploy/deploy.env --profile backup run --rm backup sh -c '
  export PGPASSWORD="$POSTGRES_PASSWORD"
  dropdb -h postgres -U "$POSTGRES_USER" --if-exists restore_check'
```

Restoring one table rather than all of them is what `-Fc` is for: `pg_restore -t member_avatar --data-only` against a live database, after taking a dump of the live one first.

### Redis is still not backed up, on purpose

`redis-data` holds sessions and 30-minute magic-link token hashes, and nothing else. Losing it costs everyone signed in one sign-in, and costs an in-flight magic link a second click on "email me a link". There is nothing in there a restore would return that a member cannot recreate in ten seconds, and a backup of it would be a rolling copy of every live session token sitting on a third party's storage — a liability with no matching benefit. It stays unprotected as a decision, not as an oversight. What would reverse it is Redis being given anything that is not reconstructible from a sign-in.

### What is still unprotected

A schedule and a retention window are not continuous protection, and an operator who reads "backed up" as "nothing can be lost" will find the difference during the incident.

- **Up to 24 hours of writes**, between the last dump and the loss. In this application that is member profile edits, avatar uploads, stars, group-admin grants and any landing, manifesto or code-of-conduct edit made since 03:15 UTC. Point-in-time recovery would close it, and needs WAL archiving and a destination that can hold a continuous stream, which is a larger change than this one.
- **Plus however long the loss goes unnoticed.** The absence alert fires within 26 hours of backups stopping; nothing here detects data loss itself.
- **The identity, not the dumps, is now the single point of failure.** Every object on B2 is unreadable without it. Two recipients and an escrow copy are the mitigation, and the quarterly drill is what proves the mitigation works.
- **`redis-data`**, deliberately, as above.
- **A dump that has never been restored is a hypothesis.** The procedure above was exercised end to end when it was written; it goes stale the same way anything else does.

## Container isolation

The three containers keep their own network namespace and the stack publishes exactly one port. That is correct on any host; on a shared one it is also what stops the container reaching every other tenant's loopback-bound service:

```yaml
ports:
  - '127.0.0.1:5880:5880'
```

That is the whole boundary in both directions. Inbound, the socket exists only on the host's loopback, so nginx is the only way in and no request skips the TLS, HSTS and `X-Forwarded-For` handling in [reverse proxy](#reverse-proxy); publishing to `0.0.0.0` would put `adapter-node` on the public interface with none of it applied. Outbound, `127.0.0.1` in the container is the container's own loopback, not the server's, so the app cannot reach the loopback-bound services other applications on that box run without authentication.

`HOST` is deliberately unset in `docker-compose.yml`. The image defaults to `0.0.0.0`, which is the container's namespace and not the host's. Pinning `127.0.0.1` there binds a loopback the port mapping cannot reach, and every proxied request 502s.

**Postgres and Redis are services in the same compose file and cross no boundary.** The app reaches them at `postgres:5432` and `redis:6379`, names that resolve on the compose network alone. Neither carries a `ports:` key: a database published even to `127.0.0.1` is on a shared host's loopback, which is the same finding in miniature, and Redis holds the sessions — reaching that port is signing in as anyone. Nothing bridges to the host, so `extra_hosts` is gone with the host-bound Postgres it was for.

The app takes the full posture: `read_only: true` with a 64 MB `tmpfs` on `/tmp` (it persists to Postgres and Redis and writes no files), `cap_drop: [ALL]`, `no-new-privileges`, 512 MB. The image already runs `USER node`. Redis takes the same posture and holds no capabilities either, because `user: redis` skips the entrypoint's root branch entirely — the image ships `/data` owned by `redis`, so nothing needs chowning. It runs unauthenticated: nothing off that network can reach the port.

Postgres is the one that cannot. Its entrypoint chowns `PGDATA`, runs `initdb` and writes a socket to `/var/run/postgresql`, so `read_only: true` fails on first boot and a bare `cap_drop: [ALL]` fails with it. It keeps `no-new-privileges` and drops every capability except the five that work needs (`CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`), which still costs it `NET_RAW`, `MKNOD`, `SYS_CHROOT` and the rest of Docker's default set.

Memory ceilings are explicit on every container: 512 MB app, 512 MB Postgres, 256 MB Redis, so the stack fits in about 1.3 GB beside whatever else the host runs. Redis carries `maxmemory 192mb` with `allkeys-lru` under its own limit, so memory pressure evicts a session rather than handing the OOM killer a choice of victims on a machine that may also serve other sites.

`depends_on` with `condition: service_healthy` orders the app behind both data services, each with a real healthcheck. The app tolerates an absent database — `ensureSchema` logs `schema.migrate.error` and keeps serving — so losing that race yields a live site on an empty schema, which is worse than a container that refuses to start.

## Reverse proxy

nginx terminates TLS and proxies to `127.0.0.1:5880`. `deploy/nginx/example.conf` is the server-block template; its header carries the certbot and install commands. Exactly one host reaches the app, because the session cookie is scoped to one apex and `ORIGIN` names one host (see [configuration](configuration.md#hostname-public_base_domain--origin)). Every other name the site answers to, the bare apex included, 301s straight to that host rather than through an intermediate one.

Rate limiting and abuse logging key on the client address, and `adapter-node` reports the TCP peer (nginx's loopback address) unless it is told otherwise:

| Variable         | Value             | Why                                                  |
| ---------------- | ----------------- | ---------------------------------------------------- |
| `ADDRESS_HEADER` | `X-Forwarded-For` | Read the client address from the header nginx writes |
| `XFF_DEPTH`      | `1`               | One trusted hop — nginx, with nothing in front of it |

Both live in `docker-compose.yml`, and both are pointless without the `proxy_set_header X-Forwarded-For` line in the server block: nginx passes a client-supplied header through untouched, so setting `ADDRESS_HEADER` alone lets the caller choose their own rate-limit key. `XFF_DEPTH` counts proxies from the app backwards; a value above the real hop count reads an entry the client wrote. Add a CDN or load balancer in front of nginx and the count goes up in the same change.

The app is deliberately unimpressed by disagreement between the two: a request missing the header logs `proxy.address-header-missing` at warn and keys on the peer address instead (`src/lib/server/client-address.ts`). Local `pnpm dev` sets neither variable and needs no proxy — the peer is already the client there.

## Logs

Every log this deployment writes is kept at most 30 days, because the community's privacy notice says so and a stated retention nothing enforces is worse than none. Three streams carry visitor or member data, and each needs its own limit, because none of the host's defaults is 30 days.

| Stream                                  | Where it lands                         | What bounds it                                              |
| --------------------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| Container output (app, Postgres, Redis) | journald, tagged `community-{{.Name}}` | `MaxRetentionSec=30day` in a journald drop-in               |
| nginx access and error logs             | `/var/log/nginx/community/`            | its own logrotate rule: daily, `rotate 30`, `maxage 30`     |
| Any shipped copy (Loki, etc.)           | wherever the host's agent sends it     | that store's own retention, which has to be 30 days or less |

The containers log to journald rather than Docker's `json-file`, which rotates by size: a quiet month keeps lines longer than 30 days. `docker compose logs` reads the journal the same way, so nothing changes for whoever is debugging. The driver alone enforces nothing, though. The host supplies the limit:

```sh
sudo install -d /etc/systemd/journald.conf.d
printf '[Journal]\nMaxRetentionSec=30day\nSystemMaxUse=1G\n' | sudo tee /etc/systemd/journald.conf.d/30-day-retention.conf
echo ':programname, startswith, "community-" stop' | sudo tee /etc/rsyslog.d/10-community-containers.conf
sudo rsyslogd -N1 && sudo systemctl restart systemd-journald rsyslog
```

The journald limit covers the whole host's journal, not only these containers; journald has no per-unit retention. The rsyslog rule exists because Debian and Ubuntu forward the journal to `/var/log/syslog`, which rotates weekly with four copies and so keeps about 35 days. Matching the `community-` tag keeps these containers' lines out of it while every other service's still reach it.

nginx logs move out of `/var/log/nginx/*.log` for the same reason: the distribution's rule there keeps 52 days and covers every site on the box. `deploy/nginx/example.conf` sets `access_log` and `error_log` in each server block, which also stops the http-level defaults from copying these requests into the shared files. Create the directory and the rule once:

```sh
sudo install -d -o root -g adm -m 755 /var/log/nginx/community
sudo tee /etc/logrotate.d/nginx-community >/dev/null <<'ROT'
/var/log/nginx/community/*.log {
        daily
        missingok
        rotate 30
        maxage 30
        compress
        delaycompress
        notifempty
        create 640 www-data adm
        sharedscripts
        postrotate
                [ -f /run/nginx.pid ] && kill -USR1 `cat /run/nginx.pid`
        endscript
}
ROT
sudo logrotate -d /etc/logrotate.d/nginx-community
```

A log agent that ships these files elsewhere needs the new path added, and the destination's retention checked: a 30-day file feeding a 90-day store keeps 90.

Lines written before a host adopted this layout stay in the shared files until the old rule ages them out, 52 days on a stock Ubuntu nginx. They are interleaved with other sites' lines, so they are left alone rather than filtered in place.

## Security headers

Split between the app and the proxy, one owner per header, because the same header set in two places with two values is a debugging session nobody enjoys.

| Header                      | Set in                               | Value                                                             |
| --------------------------- | ------------------------------------ | ----------------------------------------------------------------- |
| `Content-Security-Policy`   | `svelte.config.js` (`kit.csp`)       | Nonced per response, rendered pages only                          |
| `Referrer-Policy`           | `src/lib/server/security-headers.ts` | `strict-origin-when-cross-origin`, `strict-origin` under `/auth/` |
| `X-Content-Type-Options`    | `src/lib/server/security-headers.ts` | `nosniff`                                                         |
| `X-Frame-Options`           | `src/lib/server/security-headers.ts` | `DENY`                                                            |
| `Strict-Transport-Security` | `deploy/nginx/example.conf`          | `max-age=63072000; includeSubDomains`                             |

The app takes everything except HSTS: those headers are then version-controlled, true under `pnpm dev`, and present on the endpoints (`/avatar/<id>`, `/api/*`) that a page CSP never touches. nginx takes HSTS alone, because TLS terminates there and the responses nginx generates itself — the `:80` redirect, a 413 from `client_max_body_size`, a 502 while the container restarts — never reach the app. `add_header` does not inherit into a `location` block that declares one of its own, so a new `location` has to repeat the HSTS line.

`/auth/*` tightens to `strict-origin` because a magic-link token rides in the query string: the page that renders when a token is missing, used or expired keeps `?token=…` in the address bar, and an outbound click from there would otherwise put a live sign-in URL in a third party's referrer log. `strict-origin` sends the bare origin to every destination and a path to none, so the token cannot ride out.

**It is deliberately not `no-referrer`, which closes the same leak and breaks sign-in.** Fetch consults the referrer policy when it builds the `Origin` header for any method that is not GET or HEAD, and under `no-referrer` the browser sends `Origin: null`. SvelteKit's `csrf.checkOrigin` compares that against `event.url.origin` and answers 403 `Cross-site POST form submissions are forbidden` — so the confirm button on `/auth/magic` cannot submit to its own page. Every policy in the `strict-origin` family is exempt unless the request downgrades https to http, which TLS termination at nginx rules out. Any change to this value has to keep the `Origin` header intact; `security-headers.test.ts` asserts the family membership rather than the literal string for that reason.

That interaction is invisible to local development: `@sveltejs/kit`'s `respond.js` wraps the whole CSRF check in `if (!DEV)`, so `pnpm dev` accepts a POST that production refuses. Confirming a change to any auth-page header needs a production build (`pnpm build && node build/index.js`) or the live site.

Two surfaces carry nothing, both deliberately:

- **Static files** (`/_app/*`, `/fonts/*`, `/imgs/*`, `/favicon.*`, `/robots.txt`). `adapter-node` serves these from its own middleware, ahead of SvelteKit's hooks, so no handler sees them. Repo-controlled content only — nothing user-supplied is served from those paths (uploads go through `/avatar/<id>`, which is an app route and does carry the baseline). Serving user content from a static path is the trigger to move these headers into a dedicated nginx `location`.
- **Redirects thrown by a hook** — the 303 to `/login` from the auth gate in `hooks.server.ts`. A redirect thrown inside `handle` unwinds past the outer handlers, so nothing decorates it. No body, and the destination carries the full set. Redirects thrown by a `load` (the magic-link success hop) go through `resolve()` and do carry the headers.

## Mail DNS

Sign-in is a magic link, so a sending domain whose mail lands in spam locks members out. The domain in `MAIL_FROM` (by default `PUBLIC_BASE_DOMAIN`) needs four records before the first member signs in:

| Name                                | Type  | Value                                            |
| ----------------------------------- | ----- | ------------------------------------------------ |
| `example.org`                       | `MX`  | your mail host, if the domain receives mail      |
| `example.org`                       | `TXT` | `v=spf1 ip4:<relay v4> ip6:<relay v6> ~all`      |
| `<selector>._domainkey.example.org` | `TXT` | the relay's DKIM public key for that selector    |
| `_dmarc.example.org`                | `TXT` | `v=DMARC1; p=none; rua=mailto:dmarc@example.org` |

- **SPF names the relay's addresses**, not `mx`, so authorizing a sender and pointing inbound mail stay separate decisions. `~all` while the domain has no sending history: a hard fail breaks at any forwarder, and DKIM is what carries alignment through one.
- **Every name that never sends gets `v=spf1 -all`**, the `www` host and any redirecting domain included. A wildcard TXT does not cover a name that already has records of its own (RFC 4592), so the `www` host needs an explicit one.
- **A domain that accepts no mail publishes a null MX** (`MX 0 .`). With no MX at all, senders fall back to the A record and queue for days against a closed port 25 before bouncing.
- **DMARC starts at `p=none`.** Read a week of aggregate reports, then move to `p=quarantine` and `p=reject` once they show every message aligned. A policy is an instruction to other people's mail servers about mail nobody has measured yet, and the cost of being wrong is quarantined sign-in links.

Confirm the published key is the one the relay signs with, rather than a record of the right length: `dig +short TXT <selector>._domainkey.example.org`, then verify a received message against it.

Test placement with addresses on providers that owe the domain nothing (Gmail, Outlook, Yahoo), and read `Authentication-Results`. Mail sent to a mailbox on the relay's own server is never evaluated by it, so it proves only that sending works.
