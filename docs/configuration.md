# Configuration

Every environment variable the platform reads, what it takes, and what happens without it. The app reads its variables at runtime from the secrets file `docker-compose.yml` names in `env_file:` (`$LOREM_SECRETS_DIR/.env` on a host, `.env` in a checkout). `LOREM_BUILD_SHA` and `CORE_TAG` are also build arguments, `SKIN_DIR` also selects the image's skin build context, and the host-layout variables in `deploy/deploy.env` are covered in [deployment](deployment.md#host-configuration-deploydeployenv).

`.env.example` is the template `deploy/bootstrap.sh` copies; it carries a comment for every key it sets. A test (`src/configuration-doc.test.ts`) fails when the code reads a variable that has no row on this page.

## Variables

Types: **text** is any string, **bool** is `true` or `false` unless the row says otherwise, **int** is a whole number, **list** is comma-separated.

| Variable                          | Type                                   | Default                                 | Without it, or with a bad value                                                                                                                                                                            |
| --------------------------------- | -------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ORIGIN`                          | URL                                    | none                                    | Read by `adapter-node`. Every form action fails with "Cross-site POST form submissions are forbidden" while pages keep loading. See [Hostname](#hostname-public_base_domain--origin).                      |
| `PUBLIC_BASE_DOMAIN`              | domain                                 | the skin's `site.domain`                | The session cookie, the canonical `www` URL and the mail sender follow the skin's domain, which is wrong on any other host.                                                                                |
| `SESSION_COOKIE_NAME`             | cookie token                           | `community_session`                     | An invalid value refuses to start. See [Session cookie name](#session-cookie-name-session_cookie_name).                                                                                                    |
| `SKIN_DIR`                        | path                                   | `skin/default`                          | The default skin is built and served. In an image it is `skin`, pinned by compose; the value compose reads from `--env-file` selects the build context instead. A different skin than the build's refuses to start. See [skins](skin.md). |
| `LOREM_BUILD_SHA`                 | text                                   | `unknown`                               | Build argument, stamped by `deploy/deploy.sh`. The footer shows no build commit, and `deploy.sh` skips its check that the running container is the build it made.                                          |
| `CORE_TAG`                        | text                                   | empty                                   | Build argument, stamped by `deploy/deploy.sh` with core's release tag. The footer omits the core release, and `deploy.sh` compares it with the tag it built.                                                 |
| `PORT`                            | int                                    | `3000` in a checkout, `5880` in compose | Read by `adapter-node`. Compose pins it in `environment:`, so a value in the secrets file is inert there.                                                                                                  |
| `HOST`                            | address                                | `0.0.0.0`                               | Read by `adapter-node`. `127.0.0.1` inside the container binds a loopback the published port cannot reach, and every proxied request 502s.                                                                 |
| `BODY_SIZE_LIMIT`                 | size                                   | `512K`; compose sets `6M`               | Read by `adapter-node`. Below 2 MB, an avatar upload is refused by Node before the app can say why.                                                                                                        |
| `LOG_LEVEL`                       | `debug` \| `info` \| `warn` \| `error` | `info`                                  | An unknown value logs at `info`.                                                                                                                                                                           |
| `SITE_GATE`                       | `off` \| `password`                    | `off`                                   | Any other value refuses to start. See [development gate](features.md#development-gate).                                                                                                                    |
| `SITE_GATE_PASSWORD`              | text                                   | none                                    | Required when `SITE_GATE=password`; absent refuses to start. Changing it signs every tester out of the gate.                                                                                               |
| `SITE_GATE_MAX_AGE`               | int, seconds                           | `2592000` (30 days)                     | A value that is not a positive whole number refuses to start.                                                                                                                                              |
| `ADMIN_SUBJECTS`                  | list of `email:<addr>`                 | empty                                   | No superadmin. Per-group admins in `group_admin` still work; nobody can grant the first one. `pnpm seed` copies these into `group_admin`.                                                                  |
| `POSTGRES_HOST`                   | host                                   | `127.0.0.1`; compose sets `postgres`    | The app connects to the loopback, which inside a container is the container's own and holds no database.                                                                                                   |
| `POSTGRES_PORT`                   | int                                    | `5433`; compose sets `5432`             | As `POSTGRES_HOST`. 5433 because 5432 is usually taken on a developer machine.                                                                                                                             |
| `POSTGRES_DATABASE`               | text                                   | `lorem`                                 | Must match `POSTGRES_DB` in `postgres.env`, which the database container reads. A mismatch fails every query.                                                                                              |
| `POSTGRES_USER`                   | text                                   | `lorem`                                 | As `POSTGRES_DATABASE`.                                                                                                                                                                                    |
| `POSTGRES_PASSWORD`               | text                                   | empty                                   | Authentication fails unless the server trusts the connection, and every page that reads the directory errors.                                                                                              |
| `POSTGRES_SSL`                    | bool                                   | `false`                                 | Plaintext to Postgres, correct only while it listens on the same host or compose network.                                                                                                                  |
| `POSTGRES_SSL_CA`                 | path or PEM                            | none                                    | With `POSTGRES_SSL=true`, only the system trust store is trusted, so a private-CA provider fails the handshake.                                                                                            |
| `POSTGRES_SSL_INSECURE`           | bool                                   | `false`                                 | `true` keeps TLS and stops checking the certificate, and logs `postgres.ssl-insecure` at warn on every start. Diagnosis only.                                                                              |
| `LOREM_WRITERS_STOPPED`           | database name                          | none                                    | Read by `scripts/migrate.ts` and `scripts/seed.ts`. While a migration that needs the app stopped is pending, the runner refuses. See [migrations](deployment.md#migrations).                               |
| `REDIS_URL`                       | URL                                    | none; compose sets `redis://redis:6379` | The Upstash REST pair is used instead; with neither, every sign-in fails. See [Redis](#redis).                                                                                                             |
| `UPSTASH_REDIS_REST_URL`          | URL                                    | none                                    | Read only when `REDIS_URL` is unset.                                                                                                                                                                       |
| `UPSTASH_REDIS_REST_TOKEN`        | text                                   | none                                    | As `UPSTASH_REDIS_REST_URL`.                                                                                                                                                                               |
| `LOREM_REDIS_PREFIX`              | text                                   | `lorem-prod`                            | Two deployments sharing one Redis read each other's sessions and tokens. Set a distinct value per deployment.                                                                                              |
| `MAIL_TRANSPORT`                  | `smtp` \| `mailgun`                    | `smtp`                                  | Any other value, or `mailgun` without its sending domain, refuses to start: the boot check throws (`boot.mail-refused`). See [Mail](#mail).                                                                |
| `SMTP_HOST`                       | host                                   | none                                    | Every send throws. `pnpm dev` prints the sign-in link to the console instead.                                                                                                                              |
| `SMTP_PORT`                       | int                                    | `587`                                   | 587 is STARTTLS, 465 implicit TLS. `25` is refused by name: it is relay, not submission.                                                                                                                   |
| `SMTP_USER`                       | text                                   | none                                    | Every send throws; the client never submits unauthenticated.                                                                                                                                               |
| `SMTP_PASSWORD`                   | text                                   | none                                    | As `SMTP_USER`. Redacted from every log line and audit row.                                                                                                                                                |
| `MAIL_FROM`                       | address                                | `no-reply@<PUBLIC_BASE_DOMAIN>`         | A value on a domain the relay holds no DKIM key for sends unsigned mail, which lands sign-in links in spam.                                                                                                |
| `NOTIFY_ADMIN_ADDRESS`            | list of addresses                      | none                                    | No membership-request notice is sent; logged as `membership-request.notify-skipped`.                                                                                                                       |
| `MAILGUN_PRIVATE`                 | text                                   | none                                    | Ignored under `smtp`; required under `mailgun`.                                                                                                                                                            |
| `MAIL_DOMAIN`                     | domain                                 | none                                    | Ignored under `smtp`. Under `mailgun`, unset refuses to start and names the variable.                                                                                                                      |
| `AUDIT_RETENTION_DAYS`            | int, days                              | `90`                                    | Retention for every audit category but `authz`; `0` keeps forever. An invalid value logs `audit.config-invalid` and nothing is pruned.                                                                     |
| `AUDIT_RETENTION_DAYS_AUTHZ`      | int, days                              | `365`                                   | As `AUDIT_RETENTION_DAYS`, for `authz` rows.                                                                                                                                                               |
| `AUDIT_RECORD_PRIVATE_VALUES`     | `1`, `true`, `yes`, `on`               | off                                     | Off records `<set>`/`<empty>` for private fields. On records the values and logs `audit.private-values.ENABLED` at error on every boot.                                                                    |
| `IMPORT_CONFIRM_REMOVALS_PERCENT` | int, 0 to 50                           | `10`                                    | Removals above this share of the roster need the count typed. Any other value switches the import off with an error naming the variable.                                                                   |
| `ADDRESS_HEADER`                  | header name                            | none; compose sets `X-Forwarded-For`    | Rate limits key on the TCP peer, which behind a proxy is the proxy, so every visitor shares one bucket. See [reverse proxy](operations.md#reverse-proxy).                                                  |
| `XFF_DEPTH`                       | int                                    | none; compose sets `1`                  | Read only when `ADDRESS_HEADER` is `X-Forwarded-For`. Unset or not a positive integer logs `proxy.xff-depth-invalid` and keys on the peer. Above the real proxy count, it reads an entry the client wrote. |

## Hostname (`PUBLIC_BASE_DOMAIN` + `ORIGIN`)

The deployment's **apex domain** is a single env variable, defaulting to the skin's `site.domain` (`example.org` in `skin/default`; see [skins](skin.md)), so an unset variable falls back to the host that skin is served on. All host-derived values flow from it (defined in `src/lib/site.ts`):

- **Session-cookie scope** — cookies are set with `Domain=.<apex>`, so every subdomain shares sign-in. The apex is why `www.example.org` and a bare `example.org` would share a session: the cookie is scoped to `.example.org`, and no subdomain ever appears in it.
- **Canonical www URL** (`https://www.<apex>`) — used for the links and the logo in the sign-in email.
- **Email branding** — the sender display name and the `hello@<apex>` fallback addresses.

`ORIGIN` is the second half and is **not** derived from it — set both, together, and make them name the same deployment:

```dotenv
PUBLIC_BASE_DOMAIN=example.org
ORIGIN=https://www.example.org
```

Both live in the production env file (`$LOREM_SECRETS_DIR/.env`, loaded by `docker-compose.yml`'s `env_file:`), never in the compose file's `environment:` block, which wins over the env file and would take a second compose file with it. `adapter-node` compares the browser's `Origin` header against `ORIGIN` on every form POST, so an `ORIGIN` that names the wrong host rejects **every** form action — sign-in, profile edit, admin approve — with "Cross-site POST form submissions are forbidden" while page loads keep working perfectly. A green page load proves nothing about `ORIGIN`; submit something.

Set the **apex**, not the full hostname — `example.org`, never `www.example.org`. A full hostname wouldn't break its own deployment, but it narrows the cookie so other subdomains stop sharing sign-in, and the branding strings pick up the subdomain. `ORIGIN` is the opposite: it takes the full canonical hostname, because it is compared against a browser origin rather than used to scope a cookie.

**Moving the apex signs everyone out, once.** The cookie no longer matches, so every live session is dropped the moment the value changes. Expected, one-time, and nothing to purge: `SESSION_TTL` is 24 hours, so the old cookies lapse on their own. Announce it rather than letting support discover it.

Not derived from it: the magic-link **confirm** URLs (those follow the request origin, which is `ORIGIN` when it is set) and the community's own name, which comes from the skin's `site.name`. The mail sender is derived from it — `MAIL_FROM` defaults to `no-reply@<PUBLIC_BASE_DOMAIN>` — which means moving the apex without moving the DKIM key sends unsigned mail. See [Mail](#mail).

### Passkeys (`auth.passkeys`)

Passkey sign-in is a skin setting, not an environment variable: `auth.passkeys` in the skin's `skin.yaml`, a boolean that defaults to `true`, so leaving the key out leaves passkeys on. It is read at build time, so changing it takes a rebuild. With `false`, `/auth/passkey` and `/members/<id>/passkeys` return 404, the login page renders no passkey control, the email field's autocomplete goes back to `email`, and the profile edit page has no Passkeys card. Stored credentials stay in `passkey_credential` and work again if the key is switched back on. The magic link works either way. The key's row is in [skins](skin.md#sign-in), and the behavior in [features](features.md#passkeys).

```yaml
auth:
  passkeys: false
```

The two hostname variables above decide where a passkey works:

- **Relying party ID** is the apex, `PUBLIC_BASE_DOMAIN`. A browser binds every passkey to it when the passkey is made. **Moving the apex orphans every passkey**: none of them will sign in under the new one, and members fall back to the magic link and register again. Unlike the session cookies, those dead credentials do not lapse on their own. Each member removes theirs from the edit page, or an operator deletes the table's rows.
- **Accepted origins** are `ORIGIN` and `https://www.<apex>`. An assertion signed on any other origin is refused, so an `ORIGIN` naming the wrong host fails passkey sign-in as surely as it fails form actions.

A browser offers WebAuthn only in a secure context: HTTPS, or `localhost` and its subdomains. A local run needs a `*.localhost` name for both variables, for example `PUBLIC_BASE_DOMAIN=f08.localhost` and `ORIGIN=http://www.f08.localhost:5899`.

### Session cookie name (`SESSION_COOKIE_NAME`)

| Variable              | Value                                      | Notes                                                                      |
| --------------------- | ------------------------------------------ | -------------------------------------------------------------------------- |
| `SESSION_COOKIE_NAME` | a cookie name, default `community_session` | The cookie that carries the session id. An invalid value refuses to start. |

The session cookie is scoped to `.<apex>`, so the browser sends it to every host under the apex, whichever deployment set it. **Two deployments under one apex must set different names**: a new build at `new.example.org` beside the one at `www.example.org`, say. With one name between them, signing in on either overwrites the other's cookie, and each server looks the other's session id up in its own Redis, finds nothing, and clears it. The default replaced `_lorem_s`, the name earlier builds hard-coded, so a deployment that leaves the variable unset already differs from one of those; two deployments of this build need the variable set on at least one of them.

```dotenv
# in the second deployment's env file
SESSION_COOKIE_NAME=community_session_new
```

It lives in the same env file as the two variables above. The app refuses to start, with an error naming `SESSION_COOKIE_NAME` and the reason, when the value

- is not an RFC 6265 cookie token (letters, digits and ``!#$%&'*+-.^_`|~``; no spaces, `;`, `=` or quotes),
- begins `__Host-`, a prefix browsers accept only on a cookie with no `Domain` attribute, which this one has, or
- is a name the app already sets: `community_gate`, the [development gate](features.md#development-gate)'s cookie, or `community_utm` or `community_cohort`, the two retired cookies. Earlier builds set those on every visitor; this one sets neither and expires either one a browser still presents.

The value is read as written and never trimmed. Only a variable that is absent takes the default: `SESSION_COOKIE_NAME=` with nothing after it, or a value with a space or tab on either side, is not a cookie token and refuses to start. Delete the line to get the default.

A browser drops a `Set-Cookie` it considers invalid and tells the server nothing, so without the refusal a bad name would look like sign-in looping with an empty log.

**Changing the name on a running deployment signs everyone out, once**, as moving the apex does: the server stops reading the cookie browsers hold. The old cookies lapse on their own within `SESSION_TTL`. The first deploy of a build carrying this variable is such a change and signs every member out once, because the default is no longer `_lorem_s`.

The configured name is also a redacted key in the log and the audit trail, so a context that carries the cookie by name emits a digest, not the session id.

## Mail

Three messages leave the app, all over one transport chosen by `MAIL_TRANSPORT`; the [variables](#variables) table has each key, and [features](features.md#mail) describes the messages and how they are built.

**The TLS posture is not configurable.** Submission is authenticated and the certificate is verified: `smtp.ts` refuses port 25, refuses to submit credentials to a server that does not advertise STARTTLS, aborts if the server sends bytes ahead of the handshake (the STARTTLS command-injection class), and exposes no key that relaxes `rejectUnauthorized`. A certificate error on this path is a certificate to fix. `src/lib/server/smtp.test.ts` pins each of those.

The relay's certificate is checked against the system trust store, and there is no SMTP equivalent of `POSTGRES_SSL_CA`: use a relay whose certificate is publicly issued.

## Redis

`@upstash/redis` speaks REST only, so it has no offline mode. `src/lib/server/redis.ts` is a narrow interface over the operations the session store and magic-link flow issue, with two backends: `REDIS_URL` selects a plain Redis server, and its absence falls back to the Upstash REST client. Adding an operation means implementing it on both.

`docker-compose.yml` runs the RESP backend against its own Redis service: `REDIS_URL=redis://redis:6379`. The seam made that a deployment decision rather than a code change, and self-hosting it takes the WAN round-trip to a third party off every authenticated request and out of the availability story. The Upstash backend is there for a deployment with no Redis of its own.

Do not write `redis://127.0.0.1:6379` in a container's environment. That loopback belongs to the container, which runs no Redis — the service name is the address, and the same holds for `POSTGRES_HOST`.

## Ports

This project reserves **5870–5882**. Ports are a shared resource on a developer machine, so the band is written down here rather than only in a compose file — check this table before claiming a port, and add to it rather than picking something free-looking.

| Port | Bound to    | What                                                  |
| ---- | ----------- | ----------------------------------------------------- |
| 5870 | `127.0.0.1` | Vite dev server (`pnpm dev`)                          |
| 5880 | `127.0.0.1` | Node server — `pnpm preview`, the container, `EXPOSE` |
| 5881 | `127.0.0.1` | Postgres, `docker-compose.dev.yml`                    |
| 5882 | `127.0.0.1` | Redis, `docker-compose.dev.yml`                       |

Dev and production sit on different ports on purpose: `pnpm dev` and the production container can run at once. Both Vite ports set `strictPort`, so a collision fails with a port-in-use error instead of drifting onto 5871 and quietly taking a neighbor's reservation.

Nothing binds `0.0.0.0` on the host. The production container is the one place that reads differently: its process binds `0.0.0.0:5880` inside its own network namespace, and the loopback restriction lives on the published port instead — see [container isolation](operations.md#container-isolation).

The table is a map of a developer machine. In production only 5880 appears on the host at all: Postgres and Redis publish nothing and answer on the compose network, at `postgres:5432` and `redis:6379`. Those two numbers are not reservations — they are container-internal, so they collide with nothing on the host and never move.

`POSTGRES_PORT` defaults to **5433** in code (`src/lib/server/postgres-config.ts`) because 5432 is usually taken; local development overrides it to 5881 via `.env`, and production pins 5432 in `docker-compose.yml` because inside the container nothing is competing for it.
