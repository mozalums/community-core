# Features

What the platform does for a community and its members, one section per surface. Configuration lives in [configuration](configuration.md), storage in [data model](data-model.md), and the skin a community supplies in [skins](skin.md).

## Clean URLs (single-tenant reroute)

The default group is served at clean root URLs — `/`, `/members`, `/admin`, … — via a universal `reroute` hook (`src/hooks.ts`) that maps those paths onto the `/group/[slug]/*` route tree without changing the browser URL. The canonical `/group/<slug>/...` URLs also still work. When multiple groups land, delete the hook and restore a real homepage.

## Community documents

`/manifesto`, `/code-of-conduct` and `/privacy` render the skin's `copy/manifesto.md`, `copy/code-of-conduct.md` and `copy/privacy.md`. A skin without one of them gets a 404 at that route and no navigation entry for it. [Skins](skin.md#copy) lists every copy file.

## Development gate

A shared password in front of the whole site, for the period where the deployment is being worked on and should not be publicly browsable. Off unless switched on.

| Variable             | Values                   | Effect                                                       |
| -------------------- | ------------------------ | ------------------------------------------------------------ |
| `SITE_GATE`          | `off` \| `password`      | Unset is `off`. Any other value refuses to start.            |
| `SITE_GATE_PASSWORD` | the passphrase           | Required when `SITE_GATE=password`; absent refuses to start. |
| `SITE_GATE_MAX_AGE`  | seconds, default 2592000 | How long one entry lasts.                                    |

```bash
# on the deploy host, in $LOREM_SECRETS_DIR/.env
SITE_GATE=password
SITE_GATE_PASSWORD=<the passphrase you hand testers>

sudo docker compose --env-file deploy/deploy.env up -d   # read at boot, not at build
```

Removing `SITE_GATE` (or setting it to `off`) and restarting takes the door away again. Both are runtime values, so neither needs a rebuild.

**This is not authentication.** It proves the visitor was told a password by somebody and nothing about who they are. Sign-in, membership and group admin sit behind it unchanged and are still enforced — the gate is a second door in front of the first, not a replacement for it.

**Revoke by rotating.** There is no per-visitor record to delete. The cookie is an HMAC keyed on `SITE_GATE_PASSWORD`, so changing that value invalidates every cookie already handed out and puts every tester back at the door on their next request.

The gate is the second handler in `src/hooks.server.ts`, immediately inside `securityHeaders` and above everything else, so a gated request costs no Redis or Postgres round-trip. It returns its responses rather than throwing, which is what keeps the header baseline on them — see the note on thrown redirects at the bottom of that file. Guessing is metered at 10 attempts per 15 minutes per client address, through the same counters the sign-in sender uses. A Redis outage removes the cap, not the check.

**Testing it with `curl` needs an `Origin` header.** SvelteKit's own CSRF check runs before `handle`, so a form-encoded POST without one is refused with `403` before the gate ever sees it — which reads exactly like a broken gate:

```bash
curl -X POST -d 'gate-password=…' https://www.example.org/                    # 403, SvelteKit
curl -X POST -d 'gate-password=…' -H 'Origin: https://www.example.org' …      # the gate answers
```

Browsers send `Origin` on every POST, so nobody using one meets this. The gate keeps its own origin check regardless: it is the response built inside the hook that SvelteKit's protection does not cover.

### What the gate does not cover

One path is exempt, matched exactly: `/healthz`, because the healthcheck compiled into the image polls it and would otherwise mark the container unhealthy. `/auth/magic/send` stays gated: it mails whatever address it is given, and a closed site is exactly when it should not be reachable.

Static files are also exempt, and not by choice: `adapter-node` builds its chain as `sequence([serve(client), serve_prerendered(), ssr])`, so `sirv` answers anything under `build/client` before SvelteKit's `handle` hook runs. Measured against a production build with the gate on:

| Request                                    | Result    |
| ------------------------------------------ | --------- |
| `/`, `/members`, any form action, `/api/*` | gate page |
| `/imgs/`, `/_app/immutable/`               | gate page |
| `/_app/immutable/entry/app.<hash>.js`      | 200       |
| `/favicon.svg`, `/robots.txt`              | 200       |
| `/_app/version.json`                       | 200       |

`sirv` does not list directories — the two directory requests fall through to the gated handler — so nothing is enumerable, and the bundle's filenames are content hashes that appear only inside a page the gate refuses to render. What is reachable by guessing a name is branding assets and a build timestamp, and none of it is member data. Closing that gap means putting the gate ahead of `sirv`, which means a wrapper entrypoint in place of `node build/index.js`.

## Auth (magic link)

Self-hosted passwordless sign-in:

- `/login` — enter an email (also the no-JS fallback for the landing-page modal). The wordmark links home and a line under the form links to `/join`, both for the group named in `callbackUrl`. A single-use token (hashed at rest in Redis, 30-minute TTL, rate-limited per email and IP) is mailed over the relay described in [Mail](#mail).
- `/auth/magic` — the emailed link opens a confirmation page. The GET only reads the token; the "Sign in" button POSTs a form action, which is what consumes it and mints a session in **Redis**, carried by the cookie [`SESSION_COOKIE_NAME`](configuration.md#session-cookie-name-session_cookie_name) names. The session subject is `email:<addr>`, which is what member matching, admin resolution, and stars key on. Consuming on POST is what keeps a mail scanner's prefetch, which is an ordinary GET, from burning a member's only way in; the CSRF cover is SvelteKit's origin check on form-content-type POSTs. When the token is missing, expired, or already spent, the same page is a "send me a new link" form rather than a statement, so every dead end has an exit.
- **Session lifetime** — 24 hours, absolute, from the moment the link is confirmed. Nothing renews it: a member signing in on Monday morning is signed out on Tuesday morning whether they were active or not. Three things carry the limit and only the last is enforced here — the Redis key's TTL (`SESSION_TTL`), the cookie's `Expires`, and an `expiresAt` deadline stamped into the session itself, which `getSession` evicts on (`src/lib/server/session-lifetime.ts`). The stamp is what makes the timeout the server's: a Redis key that loses its TTL, or a client that keeps presenting an expired cookie, would otherwise stay signed in with nothing able to notice. A request whose session is gone gets the cookie cleared, so a spent credential stops riding along on every later request.
- `/logout` — clears the session. **POST only.** A GET sign-out is reachable by any page that can put a top-level navigation in front of the browser, so every sign-out control in the tree is a form (`src/lib/components/SignOut.svelte`) and SvelteKit's origin check is what a third-party page cannot satisfy.

The post-sign-in destination travels server-side, in the Redis payload beside the token hash, never in the emailed URL: `safeLocalPath` (`src/lib/callback-path.ts`) accepts only a same-origin, non protocol-relative path, so a tampered `callbackUrl` cannot become an open redirect, and anything rejected falls back to `/members`. Both ends of the flow say where the link points. `auth.magic.sent` carries `dest` and `defaulted`; `auth.magic.verified` carries `dest`. `defaulted` is true whenever no usable origin reached the sender, which covers every recovery-form resend, since that link's destination died with the token it replaces. `dest` is the path only: `safeLocalPath` permits a query string, so the raw value can carry a live token, and `log.ts` keys its redaction on field names rather than on values. Addresses are digested on both lines.

The gated `members`/`admin` surfaces require a signed-in user at the hooks layer (defense-in-depth) and are served with `no-store` cache headers; the group layout also forces a reload when a browser restores a gated page from the back/forward cache, so member PII is never shown from a stale snapshot.

Refusals on those surfaces cost the refused nothing. A guest opening an admin URL is redirected to `/?login=1&next=…`; a signed-in non-admin gets a 403 rendered by `group/[slug]/+error.svelte`, which names the address they are signed in as, says it is not an admin of the group, and offers sign-out as a choice. Neither touches the session — an admin link pasted into a group thread reaches mostly non-admins, and with email-only auth every one signed out pays an inbox round trip to get back in.

## Passkeys

A passkey is a second way to sign in, beside the magic link, never instead of it. The magic link stays the way a member enrolls and the way back in when a device is lost. A skin switches passkeys off with [`auth.passkeys: false`](skin.md#sign-in); they are on otherwise.

- **Registration** happens on the member's own profile edit page (`/members/[id]/edit`), in a Passkeys card under the profile form. Only the profile's owner sees the card. A group admin editing someone else's profile does not, and the endpoint refuses them too: a passkey signs in as its member, so an admin who could add one could become anyone in the group. Adding one takes a nickname (up to 64 characters) and a session minted in the last **10 minutes**. A session's mint time is its absolute expiry minus the 24-hour lifetime, so no extra stamp is stored. An older session gets a button that mails a fresh magic link back to the same page, so a stolen session cookie cannot quietly plant a credential that signs in with no email. The options are `residentKey: 'required'` (a discoverable credential, so sign-in needs no address) and `userVerification: 'preferred'`, with no attestation requested. The member's existing credentials are excluded, so one authenticator cannot register twice.
- **Sign-in** is on `/login`, beside the magic-link form. Where passkeys are on, the email input carries `autocomplete="username webauthn"`. The page starts a conditional-mediation request on load, so the browser lists this site's passkeys in the field's autofill, and picking one signs in with no button pressed. A "Sign in with a passkey" button runs the same ceremony in a modal and aborts the pending autofill request. No credential list is sent: the browser offers whatever it holds for this site, and the server never says which addresses have a passkey.
- **Verification** looks the credential up by its id, checks the assertion's user handle against the member it belongs to, and verifies the signature against the origins and relying party below. A verified assertion mints a session through `mintEmailSession`, the function the magic link uses, with the subject `email:<addr>` taken from the member row at that moment. An address changed since the passkey was made therefore signs in as the new address. `sign_count` and `last_used_at` are updated in the same statement, conditioned on the count read before verifying, so two assertions racing on one count cannot both land.
- **Sign-count regression is refused.** An authenticator that counts never repeats a count or goes back. A presented count at or below the stored one (when either is non-zero) means a cloned key. The assertion is refused after its signature verifies, and `auth.passkey.sign-count-regression` is logged at `warn` with the member id and both counts. Authenticators that always report 0, as synced passkeys commonly do, are unaffected.
- **Challenges** are single-use and live in Redis for **5 minutes**. A registration challenge is keyed to a digest of the session id, along with the member it was issued for. A sign-in challenge has no session to key to, so it is keyed to a digest of itself and looked up from the challenge the client signed. Both are deleted on read (`GETDEL`) before verification, so a failed attempt spends one too and a replayed response finds nothing.
- **Rate limits.** A sign-in attempt spends the magic link's per-IP counter (`magic-rl:ip`, 20 per 15 minutes), so a second sign-in method does not double what one address may try. Sign-in options are capped separately at 60 per IP per 15 minutes. That cap is wide because every login page with a capable browser asks once on load; it exists because each request leaves a key in Redis.
- **Management.** The same card lists the member's passkeys (nickname, created, last used) and removes them. Removing the last one is allowed, since the magic link still works. Deleting a member deletes their passkeys by cascade.

The relying party ID is the apex domain (`PUBLIC_BASE_DOMAIN`, else the skin's `site.domain`), so one passkey works on every subdomain. The accepted origin is `ORIGIN`, or `https://www.<apex>` when `ORIGIN` is unset. See [Configuration](configuration.md#passkeys-authpasskeys) for what moving either does.

Credentials live in `passkey_credential` (migration 18), keyed by the raw credential id and owned by `member_id` with `ON DELETE CASCADE`. They are tied to the member row rather than the address, so an email change rewrites nothing there. The row holds the COSE public key, `sign_count`, the authenticator's `transports`, `backed_up` and `device_type` as reported at registration (`backed_up` refreshed on each sign-in), the nickname, `created_at` and `last_used_at`. WebAuthn is `@simplewebauthn/server` and `@simplewebauthn/browser`, pinned to exact versions in `package.json` and installed `--frozen-lockfile`. The server code is `src/lib/server/passkey-store.ts`. `src/lib/server/passkeys.ts` holds the switch and the freshness rule, which pages read without loading the store.

Log lines: `auth.passkey.registered`, `auth.passkey.removed`, `auth.passkey.verified` (address digested, with `dest`), `auth.passkey.refused` (with the reason), `auth.passkey.register-refused` and `auth.passkey.sign-in-refused` (library errors), `auth.passkey.rate-limited`, and `auth.passkey.sign-count-regression`.

## Sign-in email change

The sign-in address is the identity key: `member.email` and `member.ident_subject` in every group the member belongs to, the `group_admin` rows that make them an admin, the `member_star` rows they starred with, and the Redis index of their sessions. A member changes it themself, from a Sign-in email card on their own profile edit page (`/members/[id]/edit`). A group admin editing someone else's profile sees no card and the endpoint refuses them, because whoever sets the address can sign in as the account. The flow follows the usual pattern for this: recent sign-in to request it, proof of the new address to apply it, and a notice to the old address with a way back.

- **Request.** The card posts to `/members/[id]/email` and needs recent re-authentication, checked against how and when the session was minted (`auth` on the Redis session: `magic-link`, `passkey` or `email-change`, with a timestamp). Where the account has a passkey on any of its member rows and passkeys are on, only a **passkey sign-in from the last 10 minutes** counts: the card offers "Confirm with a passkey", which runs a passkey sign-in and comes back here, and a magic-link sign-in is refused with `passkey`. Where it has none, or the skin sets `auth.passkeys: false`, any session minted in the last **10 minutes** counts, the same freshness rule passkey registration uses, and the card offers "Email me a fresh sign-in link" to the current address. A session minted before the `auth` stamp existed counts as a magic link. The new address must be syntactically valid and differ from the current one; those two refusals are shown, since they say nothing about anyone else. An address that belongs to another member of any group, or to a group admin with no member row, gets exactly the answer a free one does ("if that address can be used, a link is on its way") and no mail. The free path mints its token and sends the link after the response returns, so the server work done before the answer is the same on both paths and response time does not separate them either.
- **Confirm.** A link goes to the new address. It is an ordinary magic-link token with `purpose: 'email-change'` in its Redis payload, single-use, **30 minutes**, and spends the same per-address (5) and per-IP (20) counters per 15 minutes as a sign-in link. Each consumer names the purpose it accepts, so a sign-in link cannot confirm a change and a change link cannot sign anyone in; a token presented at the wrong page is refused without being spent. The link opens `/auth/email`, which only peeks on GET; the "Confirm this address" button spends it, for the mail-scanner reason given under [Auth](#auth-magic-link).
- **Binding.** A change link is bound to the member row it was requested from and that row's `member.identity_epoch` at the time, not to the address. Every move of an account (a confirmed change, an undo, the operator script) sets a new epoch, from one sequence, on all of the account's rows, so a link requested before any move stops working: of two pending changes, the first one confirmed wins and the other is refused, and an undo ends every change link the account had outstanding. A link whose member row no longer holds the address it was requested from is refused the same way, so a link cannot move whoever takes over a freed address.
- **The move.** Confirming runs one transaction (`confirmChangeIn`, `src/lib/server/email-change-core.ts`). It finds the account through the bound member row: every member row, in any group, holding that row's address. It takes the member-write lock of each of those groups in id order and locks the rows, takes the identity lock exclusively, re-checks the binding, and checks that no member or admin holds the destination. The schema keeps an address unique only within a group, so the identity lock is what keeps it to one account across groups: every write that puts an address on a member or admin row (a profile created by approval or by hand, a roster import, an admin grant, another move) holds it shared through the triggers of migration 21, so the move sees every claim that has committed and none can start until the move commits. A claim racing a confirm therefore wins if it got there first, and the confirm is refused as taken. Writers take it after their group lock, as the move does, so the two orders never cross. It rewrites `member.email` and `member.ident_subject`, the `group_admin` rows, the `member_star.starrer` rows and the `member_avatar` row (so the uploaded photo and its public URL move with the address; a photo row already at the destination belongs to nobody and is replaced), records the undo grant, and writes one `member.email-changed` audit row per group. A membership that appears between finding the account and locking its groups reruns the transaction, up to three times. Then every session under the old subject is deleted, the confirming browser gets a fresh session for the new address, and it lands where the request was made. If the new address was taken in the meantime, nothing moves and the page says so.
- **Notice and undo.** After the commit, the old address gets a notice naming the new one, with an undo link: `purpose: 'email-revert'`, single-use, **7 days**. The token names a row in `email_revert_grant`, which holds the account's member ids, the address to restore and the epoch the change set. Undoing finds the account through those member ids, wherever its address has moved since, and takes in every group it belongs to now, including ones joined after the change. A member row created at the account's address while a grant is live is added to the grant's member ids (a trigger, migration 21), so the undo still reaches that membership after every row the grant was issued for has been deleted. It runs the same rewrite back to the old address, deletes every passkey on the account's rows (a hijacker may have enrolled one, and a passkey signs in as whatever address its member holds), revokes the sessions of every address involved, and writes `member.email-reverted` audit rows. It spends its grant and voids every grant issued after the change it undoes, so a hijacker who changed the address a second time cannot use the undo link mailed to their own address to take it back. Earlier grants stay valid, since they restore addresses the owner held, and a later undo cannot void an earlier one. It does not sign the clicker in; they sign in with a magic link like anyone else. A failed notice send is logged at `error` as `auth.email-change.notice-failed` and does not undo the change.

Passkeys are keyed by member id (see [Passkeys](#passkeys)), so a change by the member leaves them in place and they sign in as the new address. Membership requests in `access_request` are keyed by address and do not move.

The audit rows carry the old address in `actor_email` and `meta.from`, and the new one in `target_email` and `meta.to`; `before` and `after` hold the same addresses digested, as every `email` key is. For a revert, `actor_email` is the address being restored. A member who has lost both addresses is an operator task: see [Operations](operations.md#member-lost-both-sign-in-addresses).

Log lines: `auth.email-change.requested` (with `sent`, false for a taken or rate-limited address), `auth.email-change.confirmed`, `auth.email-change.refused` and `auth.email-revert.refused` (with the reason), `auth.email-revert.confirmed`, `auth.email-change.send-failed` and `auth.email-change.notice-failed`.

## Membership requests

Requests live in the `access_request` table.

- A **guest** gets there through `/join`, which the landing page's "Not yet a member? Register" links to (the "Login" button keeps the sign-in modal). The page lists the three steps before its email input: confirm your email, fill in the form, wait for an admin. It states that an admin reviews each request by hand, that there is no set turnaround, and that only an approval sends an email. Its form sends the same magic link `/login` does, with `/request` as the destination. A visitor already signed in is redirected to `/request`, or to `/members` if they are in.
- A signed-in **non-member** lands on `/request`. The form collects first and last name (or one name, where the skin has one name field), one checkbox per `affiliation` field the skin declares, free-text other affiliations, the public-profile opt-in, and each `links` field the skin declares, shown as the profile edit form shows it; email is read-only from their verified login. It requires exactly what the skin marks `required`, in the browser and on the server: a name control whose field is required, and a link in a required `links` field. No affiliation is ever required. Submitting writes a pending row and notifies the admins on `NOTIFY_ADMIN_ADDRESS` (if set). Five submissions per address per hour, then `429`.
- The values are stored in `access_request.data` keyed by the same field-schema keys `member.data` uses (`firstName`, `fellow`, `links`, …), with checkboxes as `TRUE`/`FALSE` and links as the `{site, handle}` list a member's are stored as, checked by the same rules before the row is written. The payload is open-ended rather than one column per field: anything the form collects later lands there without a migration. Approval splits it into `member.data` and `member.private_data` by each field's visibility, copying the links list as it is. The admins' request card shows one row per link, named by its site and linked to the built address.
- **One pending row per address per group**, enforced by the partial unique index `access_request_pending_uniq`. Submitting again while pending updates that row. Submitting after a denial adds a new pending row and keeps the denied one, so the admin card shows that this person was denied before, with the date and the reason. Resubmission is never blocked; the rate limit slows a loop.
- The **public-profile opt-in is unticked** on that form, so registering puts nobody on the public homepage. A requester either ticks it there or turns it on later at `/members/<id>/edit`. The answer is stored explicitly, so what approval copies into the member row is the requester's choice and not a default. Existing members are a separate case: every row that predates this form is checked and stays checked, by decision.
- **Admins** review at `/admin/requests` (linked from the Admin home). Both actions take the request's **id**, never the email, so a click cannot act on a request created for the same address after the page rendered.
  - **Approve** runs in one transaction: lock the row with `status = 'pending'` in the predicate, create the member from `data` through `member-write.ts` (which writes a `member.created` audit row), mark the request `approved`, and write a `request.approved` audit row. A second approval of the same request finds nothing pending and is refused with `409`, so it can never create a second member. An address that is already an active member keeps its profile. The welcome email goes out after the commit and never fails the approval.
  - **Deny** marks the request `denied` with an optional reason, writes a `request.denied` audit row, then signs the applicant out. Revoking the sessions happens after the commit and never fails the denial.

## Admin access

A visitor is a group admin if **either** of these holds (resolved server-side by `resolveGroupAdmin`):

- **`ADMIN_SUBJECTS`** env: comma-separated **subjects** (e.g. `email:you@example.com`) who are **global superadmins** across every group. Checked first and with no database read, so it still works with Postgres down. The bootstrap and break-glass path:
  ```dotenv
  ADMIN_SUBJECTS=email:you@example.com
  ```
- **`group_admin`** table: per-group admins, keyed by subject (`email:<address>`, lowercased). Managed from **`/admin/access`**: list the group's admins, grant by email address (the address need not have signed in yet), revoke. Each grant and revoke writes an `authz` row to the audit trail in the same transaction. An admin cannot revoke their own grant, so a group is never left without one by a slip; `ADMIN_SUBJECTS` stays the way back in. Changes to one group's admins take a lock on the group and re-check the acting admin under it, so two admins revoking each other cannot both succeed. If the lookup fails, the visitor is treated as not an admin rather than shown an error. `pnpm seed` also writes the `ADMIN_SUBJECTS` subjects into `group_admin`; revoking one of those rows removes only that group grant, and the account keeps admin access until it leaves `ADMIN_SUBJECTS`.

Admins see the **Admin** nav item, reach `/admin/*` (overview, landing editor, membership requests, roster import and export, admin access, audit trail), can edit any member's profile, and get into the directory even without a member row of their own.

## Roster export

`/admin/export` downloads the roster as a CSV. The admin overview links all three variants. Group admins only, checked by the same `requireGroupAdmin` every admin action uses: the file is every member's address in one request, where the directory otherwise shows the same data a page at a time.

| Query                  | Rows                 | Columns                                   | Filename                                         |
| ---------------------- | -------------------- | ----------------------------------------- | ------------------------------------------------ |
| (none)                 | active members       | `Email` and every `members` field         | `<slug>-members-<date>.csv`                      |
| `?private=1`           | active members       | adds every private field and `x.*` column | `<slug>-members-PRIVATE-<date>.csv`              |
| `?removed=1`           | adds removed members | adds `Status` (`active`, `removed`) last  | `<slug>-members-with-removed-<date>.csv`         |
| `?private=1&removed=1` | every member         | both of the above: the full export        | `<slug>-members-PRIVATE-with-removed-<date>.csv` |

Only the literal value `1` turns a variant on; anything else gets the narrower file. A `?private=1` export writes a `data` audit row, `members.export-private`, naming the admin, whether removed members were included and the row count. The row and the read share a transaction, so if the row cannot be written no file is sent. The default and removed-only variants are not audited.

The file format:

- **Columns** are the `label`s from `DEFAULT_FIELD_SCHEMA`, in its order (see [member fields](data-model.md#member-fields)), so the file reads like the profile form. `Email` is in every variant even though the field is private, because it is the identity an import matches on; its value is `member.email`, the address the member signs in with. A `?private=1` file adds `Email (stored)` right after it: the Email field as stored, which is a separate value. A roster imported from elsewhere can store an Email that is not the sign-in address, so the two can differ, and the stored one can be a list or an object. An empty `Email (stored)` cell means the member has no stored Email; it is never filled in from the sign-in address, nor the other way round. `x.*` columns follow every declared field under their original header text, or under the full `x.<header>` key when that text could be misread: it repeats a field label, `Email (stored)` or `Status` (ignoring case and surrounding spaces), starts with `x.` itself, or is blank or padded. So a heading reads back without the roster: `Email` is the sign-in address, `Email (stored)` is the Email field, any other field label is that field, `Status` is the status, a heading starting `x.` is that key, and any other heading is `x.<heading>`, which is also what a column an admin adds becomes. A full export refuses a stored key that is neither a field nor `x.*`, naming it, rather than leave its values out of the file.
- **Rows** are sorted by address. An empty cell means the member has no value; a stored empty string and a missing key are the same state.
- **Values** that are strings are written as they are. Anything else (a list, an object, a number, `true`, `null`) is written as `json:` followed by its JSON, so `["a,b","c"]` keeps its two elements and `{"unit":"ops"}` its content. A string that itself starts with `json:` is written the same way, as `json:"json:…"`, so no member's text can be read back as a structured value. A number keeps the digits PostgreSQL stores, at any precision or size, so `json:9007199254740993` and `json:1e400` come back as written rather than rounded to the nearest double or turned into `null`.
- **Links** are one column per `links` field holding the member's entries as `site:handle` pairs separated by spaces, in their stored order (`linkedin:ravinald mastodon:ravi@mastodon.social website:https://example.org/`). No accepted handle holds a space or a quote, so each is written as stored.
- **Encoding** is UTF-8 with a byte order mark (BOM). Without it Excel reads the file as the local code page and mangles every non-ASCII name.
- **Quoting** follows RFC 4180: records end in CRLF, and a cell holding a comma, a quote or a line break is quoted, quotes doubled. Line breaks inside a cell are kept as they are, so a multiline Bio survives the round trip.
- **The apostrophe.** A cell starting with `=`, `+`, `-`, `@`, a tab, a carriage return or an apostrophe is written with one extra apostrophe in front, so a spreadsheet shows `'=SUM(A1:A9)` as text instead of running it. This is deliberate: a member's profile is untrusted input, and the file is opened by people who should never have to think about formula injection. The import strips exactly one leading apostrophe, which is why an apostrophe the member typed is doubled on the way out.

**The round-trip contract:** importing an unmodified full export produces a zero-row diff. The reader and writer are one module, `src/lib/server/csv-core.ts`, that the export and the import both use, so their escaping cannot drift apart. The heading and value conventions above are `columnHeading`/`columnKey` and `encodeCell`/`decodeCell` in `src/lib/server/member-export.ts`, each the other's inverse, for the same reason. `readMemberCsv` there states the contract as code: it returns each row's sign-in address, status and stored values separately. The import (see **Roster import**) reads the same headings and cells through the same two functions, but not through `readMemberCsv`, which turns an unknown heading into a new `x.*` field.

Without a browser, `scripts/export-members.ts` writes the same file over the script pool, with `cli:export-members` as the audited actor:

```bash
pnpm export-members example --private --out roster.csv
deploy/run.sh export-members example --private --removed > roster.csv
```

It refuses to print the roster to a terminal, and `--out` creates the file `0600` and refuses to overwrite one that exists.

The endpoint is a `+server.ts`, which `route-guards.test.ts` does not discover the way it discovers form actions under `admin/`. It is listed there by hand beside the star endpoint; a new endpoint under `admin/` needs the same entry or it sits outside the test that proves an outsider gets nothing.

## Roster import

`/admin/import` (**Import roster** in the admin nav) bulk-edits the roster from a spreadsheet: export, edit in Excel, Numbers or Sheets, upload, read the preview, apply. Group admins only, through `requireGroupAdmin`; both steps are form actions, so `route-guards.test.ts` discovers them without a hand-kept entry. The code is `src/lib/server/import-core.ts` (pure: decoding, headings, validation, diff, digest, guard rails) and `src/lib/server/member-import.ts` (the lock, the SQL, the audit rows).

**Two modes.** **Merge** is the default: rows in the file are added or updated, and members missing from the file are untouched. It has no removal statement at all, and it ignores a `Status` column with a warning. **Replace** treats the file as the whole roster: a row is an active member unless its `Status` cell says `removed`, and every active member whose address is not in the file is removed (`status = 'removed'`, the row is kept).

**Columns.** A column absent from the file leaves that field alone. A column present with an empty cell clears the field for that row. Nothing is ever inferred from a missing column. Headings are matched to the field `label`s, `Email`, `Email (stored)`, `Status` and existing `x.*` columns by the rules the export writes them with, ignoring case and surrounding spaces. There are no legacy aliases. A heading that names nothing is a warning naming it, and its values are not written, so a typo can never create a field. Two headings that read as the same field are an error. The page states these rules above the file picker. A field the file changes is stored in the bag its schema visibility names; every field it does not change keeps its value and stays in the bag it is in, so an import never moves an untouched field between `data` and `private_data`. Structured values compare by their JSON with keys sorted, so jsonb's own key order is never a change.

**Links.** A `links` column holds `site:handle` pairs separated by spaces, as the export writes them. Each pair goes through the check a profile save applies, so a pasted profile address becomes its handle, and a pair naming a site the field does not offer, a handle the site refuses, a pair with no `:`, a second pair for one site, or a cell written as `json:` is reported in the preview by row, with nothing applied. A blank cell is no value, and an empty stored list never exists, since a save that removes every row removes the key.

**What makes a file invalid.** Nothing is applied, and the page lists every problem with its spreadsheet row (and file line, where a multiline cell makes them differ):

- an `Email` cell that is blank or not an address, or the same address twice (compared ignoring case and surrounding spaces). A row of separators only is a blank `Email`. A line with nothing on it is skipped only when the file has more than one column; in an `Email`-only file it is what a blanked cell saves as, so it is a blank `Email` too;
- no `Email` column;
- a row with fewer cells than the heading row, or extra non-empty cells;
- a `Status` other than `active` or `removed`, or `removed` for an address the directory does not have;
- a `json:` cell that is not valid JSON;
- a links cell with a pair the field's check refuses, or written as `json:`. The row is refused whole rather than applied without that entry;
- more than 10,000 rows or 4 MB. The size is checked from `Content-Length` before the body is read, then from the file's size, then from the bytes.

**Encodings and separators.** UTF-8 with or without a BOM, and UTF-16 either way round (Excel's "Unicode Text"). Anything else, such as a Windows code-page "CSV", is refused with a pointer to "CSV UTF-8" rather than guessed at. The separator is whichever of comma, semicolon or tab the heading row uses most, outside quotes; European Excel separates with `;`. The parser is `csv-core.ts`, the same one the export writes through, so a full export imported in replace mode is a zero-row diff, formula-guard apostrophes included.

**Preview, then apply.** The upload parses, validates and diffs against the roster, and stores the plan (the parsed rows) in `member_import_plan` with a SHA-256 digest of the diff, including the membership status of each member it edits, since the page explains an edit to a removed member as staying removed. The rows are stored as one jsonb string holding their JSON text, because a jsonb array would reorder keys and rewrite numbers such as `1e2` as `100`, and apply would then hash different values. The page shows added, changed (field by field, before and after), removed and unchanged. Apply takes the roster lock, reloads the plan, recomputes the diff against the roster as it now is, and refuses unless the digest matches the one on the page, so the admin confirms the change they read. A plan is bound to the admin who made it, deleted once applied, and expires after an hour; expired plans are deleted on the next preview. It holds private columns, which is why it is not kept.

**The lock.** The apply's first statement is the member write path's group lock, `GROUP_LOCK_SQL` in `src/lib/server/member-write-core.ts`. Every other member write (profile save, avatar, approval, sign-in bind, removal, purge) takes the same exclusive key first, so an import never interleaves with any of them, including an approval creating a member the apply's row locks cannot see. The import's inserts, updates and removals live in that module too, and take the lock token `lockGroupIn` returns rather than a bare client. Being transaction-scoped, the lock releases on commit, rollback or a dropped connection; there is no run-state row to clear.

**Removal guard rails**, against the active roster before the import:

| Removals                                     | What happens                                     |
| -------------------------------------------- | ------------------------------------------------ |
| none                                         | apply                                            |
| up to `IMPORT_CONFIRM_REMOVALS_PERCENT` (10) | apply; the button is the confirmation            |
| above that, up to half                       | the admin types the number of removals           |
| more than half                               | refused in the browser, no override; script only |
| a file with no member rows, group not empty  | refused in both modes, browser and script        |

`IMPORT_CONFIRM_REMOVALS_PERCENT` takes a whole number from 0 to 50. Anything else switches the import off with an error naming the variable, rather than falling back to a looser value. Removal is one statement, the set difference `email <> ALL (<the file's addresses>)` plus the rows marked `removed`, and the transaction rolls back if it matches any member the preview did not show.

**Audit.** One `data` row per import, `members.import`, with the mode, the counts and the digest, plus one row per member touched: `member.import-added`, `member.import-updated` (the changed fields only) and `member.import-removed` (with `via`: `absent` or `status`). All share the import's `run_id`, which the audit page folds into one block. Values are recorded in the export's cell notation, so a change from `json:true` to the text `true` shows as one. Private fields record `<set>`/`<empty>` as every other audited change does.

**The script**, for what the browser refuses. `scripts/import-members.ts` runs the same parser and writes in one transaction under the same lock, as actor `cli:import-members`. It is a dry run unless `--apply` is given, and any removal needs its exact count:

```bash
pnpm import-members example roster.csv --replace
deploy/run.sh import-members example - --replace --apply --confirm-removals 412 < roster.csv
```

`-` reads the file from stdin, which is how it reaches the container `deploy/run.sh` starts. The script takes files up to 32 MB and any row count.

## Audit trail

Every change the app makes to Postgres is recorded in one table, `audit_event`: who did it (`actor_subject`, `actor_email`), to whom (`target_email`, `target_subject`, `target_id`), in which community (`group_id`, plus `group_slug` copied beside it), what changed (`before`, `after`), anything else worth keeping (`meta`), and a `run_id` tying together the rows of one bulk action. Group admins read it at `/admin/audit`, filtered by category and target email; rows sharing a `run_id` fold into one entry.

Profile edits and deletions write Postgres alone and record themselves here, on the same transaction as the change: if the audit row cannot be written, the save or deletion rolls back and the member is left as it was, able to retry. The best-effort cleanup after a deletion (avatar, sessions) runs after the commit and is not itself audited.

### What is recorded

| Action                     | Category     | Recorded by                                      |
| -------------------------- | ------------ | ------------------------------------------------ |
| `landing.updated`          | `content`    | `/admin/landing`, text clipped to 2,000          |
| `member.updated`           | `data`       | profile edit, the changed fields only            |
| `member.email-changed`     | `authz`      | sign-in email change, one row per group          |
| `member.email-reverted`    | `authz`      | its undo link, one row per group                 |
| `member.username-released` | `data`       | an admin releasing a retired username            |
| `member.deleted`           | `membership` | profile deletion, target id is the member's id   |
| `request.submitted`        | `membership` | `/request`, with the submitted values            |
| `request.approved`         | `authz`      | `/admin/requests`, target id is the request's id |
| `request.denied`           | `authz`      | `/admin/requests`, with the reason if given      |

A new subsystem adds an action string, never a column. `category` exists only to choose a retention window.

### Transactional and best-effort writes

`auditIn(client, entry)` writes on the caller's transaction and throws, so a change and its record commit together or neither does. Every Postgres mutation uses it. Neither entry point wraps a call to an external service, because no transaction can span one.

`audit(entry)` is best-effort: it catches everything, including a failure to build the connection pool, and logs `audit.write-failed`. It is for observations with no transaction to join, and it can never fail a request. No flow calls it yet.

`audit-core.ts` holds the statement, the redaction and the prune with no SvelteKit imports, so scripts write and prune through it directly (`scripts/export-members.ts`, `scripts/prune-audit.ts`). `audit.ts` binds it to `$env` and the app's pool.

### Private fields

A field marked private on the edit form (phone, postal address, sizes) records that it changed and whether it is now set, `<set>` or `<empty>`, never the value, and its name goes in `meta.redacted`. Recording the value would make a second copy of the most sensitive data in the system, on a different retention clock, behind a different access path, and it would outlive the member row.

`AUDIT_RECORD_PRIVATE_VALUES=true` records the values instead. It is off by default and logs `audit.private-values.ENABLED` at error level on every boot while it is on, whether or not the retention settings parse. Leave it off unless you are debugging at that moment.

`before`, `after` and `meta` also pass through the logger's scrubber (`src/lib/server/redact.ts`), so a credential or an address under a denied key is digested exactly as it would be in a log line. The one value it leaves alone is a `<set>` or `<empty>` marker under a field `meta.redacted` names, so clearing the private `email` field reads as cleared rather than as two digests. A raw value under that name is still digested.

### Retention

| Setting                      | Default | Applies to                                |
| ---------------------------- | ------- | ----------------------------------------- |
| `AUDIT_RETENTION_DAYS`       | 90      | `content`, `data`, `membership`, `system` |
| `AUDIT_RETENTION_DAYS_AUTHZ` | 365     | `authz`                                   |

`0` keeps that half forever. Authorization events outlive the rest because "who granted this person access, and when" is what an incident turns on.

The app prunes itself: a timer started at boot, beside the schema step in `hooks.server.ts`, runs about five to ten minutes after start and then about every six hours, with jitter. `pg_try_advisory_lock` makes one replica do the work and the rest skip. Each pass deletes in batches of 1,000 so a first prune on a large table never holds a long transaction. The prune is not itself audited; it logs `audit.prune.done`. An invalid retention value logs `audit.config-invalid` and the timer does not start, so nothing is pruned until the value is fixed.

A cron job was rejected as the primary mechanism: an operator who never wires it keeps member data forever, and the window is a privacy control. The `prune` compose profile is the escape hatch for a prune now, or for an instance that is stopped rather than idle:

```sh
sudo docker compose --env-file deploy/deploy.env --profile prune run --rm prune
```

### Retention versus erasure

Deleting a member does not cascade to the audit rows, and must not: the row recording the deletion would go with it. `target_id` has no foreign key for that reason, and `group_id` is `ON DELETE SET NULL` for the same reason one level up.

The deletion row also finishes the removal. **Delete profile** commits the member's `DELETE` and its audit row in one transaction, then deletes the stored photo and revokes the member's sessions, which neither the avatar store nor Redis can do inside that transaction (`src/lib/server/member-removal.ts`). The action redirects to success only once all three are done and a `member.removal-completed` audit row, carrying the member id and no address, records that. If a step after the commit fails, the action answers 500 and the browser lands on `/removal/<id>`, which sits outside `members/` because the person is no longer a member. An enhanced submit gets there from the edit page's submit handler. A plain form POST gets there from the server: SvelteKit renders the page's layouts after a failed action, and the members layout and the edit page's load both redirect a requester who may finish a still-pending removal of that id to its removal page instead of to `/request` or a 404. The removal page reads the address and subject from the newest `member.deleted` row for the id and repeats every cleanup step, all of them idempotent. Only the deleted member or a group admin can open it. It answers 404, and the edit action's retry answers 404, once a member with the same address or subject exists in the group again, or once a completion row exists for the id: sessions belong to the account rather than the membership, and a finished removal must not revoke a later sign-in by the same address. Each attempt runs its cleanup in one transaction that first takes a per-removal advisory lock, then checks again, under the lock, whether a completion row or a rejoined member now exists, and stops if so: an attempt admitted before another one finished cannot go on to delete a photo or revoke a session that appeared after completion. The same transaction writes the completion row before it touches the avatar store or Redis, so a failed completion write rolls back before anything is revoked, and a cleanup failure rolls the completion row back with it. The requester's own sessions are revoked last, so a failure before that step leaves them signed in and able to retry. A failure after it (the transaction's commit) leaves them signed out of a removal still pending, so the removal page sends every signed-out visitor, for any id, to `/login?callbackUrl=/removal/<id>`; signing in again brings the subject back to it, and the redirect says nothing about whether the id is pending. A pending retry works for as long as the deletion's audit row exists; the completion row shares its `membership` category and so is never pruned first.

That puts retention in direct conflict with a right-to-erasure request. An erased member's address stays in `target_email`, and their non-private field values in `before`/`after`, until the retention window ages the rows out. Resolving that needs a separate operation that nulls the payload while keeping the event, and deciding whether to build it is a policy decision that has not been made. Until it is, whoever answers an erasure request has to say that "erased" means erased from the live database now and from the audit trail within 90 days (365 for authorization events), on top of the 30 days the backups already add.

## Member directory

- **Search** lives in the URL (`?q=`) so results are bookmarkable and server-rendered. One free-form query searches across profile data: Postgres full-text and substring matching over the values in `member.data` (never the keys, never `private_data`), every word required, then any word if nobody matches all of them. Trigram matching on name/city/handle runs only when that finds nobody, to forgive a misspelt name, and the page says the results are close spellings. Results rank a whole-word name match first (a visible part of the name counts even when another part is private), then any other whole-word match, then a substring match, and each tile names up to two visible fields the query matched (`Hobbies: cars`). A field is kept out of search by declaring it private in the field schema, which stores it in `private_data`; no list of sensitive words decides it. The query is NFKC-normalized and lowercased before it splits into words, and a word with no letter or digit (an emoji, a lone `%`) is dropped; a query left with no words lists everyone and says it had no searchable words. Both sides compare accent-folded and in NFC, so `cafe` finds `Café`, `Zoë` finds `Zoe`, and a value an older import stored decomposed still matches.
- **Field filters** answer a different question from search: `?country=Canada` lists the members whose Country is Canada, and nobody else. A parameter is read only for a field the skin marks `filter: exact` (see [Field filters](skin.md#field-filters)) that is members-visible; any other parameter is ignored and never shown back. The match is the whole stored value (the promoted `city` column for the field that alone feeds it, and the field's own `data` value for every other field, even one that alone feeds `name` or `email`), case-insensitive after NFKC and the same trim the query gets (U+FEFF included), never `ILIKE`, so `?country=United` does not find `United States`, `Georgia` the country does not find a company in Georgia, and `%` or `_` match only themselves. A blank stored value never matches, and a blank parameter is no filter. Filters AND with each other and with `q`, and stay applied through the relaxed and fuzzy passes, so a filter with no match shows nobody rather than a broader list. `?startYear=2012` lists members who started in 2012; `?q=2012` lists members whose tenure spans 2012. Above the results each filter is a chip ("Country: Canada") with a control removing that filter alone and keeping the rest and `q`, the heading reads "Filtered Directory", and the empty state names the filters, in the starred view too. On a profile, a filtered field's value links to its filter, and a City link carries the profile's country (`?city=Portland&country=United%20States`).
- **Stars**: any signed-in user can star members; `?starred=1` narrows the directory to their starred people.
- **Profiles** at `/members/<id-or-username>` render every field the viewer may see, in field-schema order: members-visible fields for any member, private fields (phone, postal address, sizes, and any `x.*` column) for admins only. The bio renders as plain text with its line breaks kept, and the only thing in it that becomes markup is an `https://` URL, which becomes a link opening in a new tab (`rel="nofollow noopener noreferrer ugc"`). The link stops at whitespace, `<`, `>` or `"`, and drops trailing `.,;:!?'` and an unmatched closing `)` or `]`; a URL `new URL()` rejects, or whose host has no dot, stays text. Every other scheme, a bare `www.`, Markdown and HTML stay text (`src/lib/bio-links.ts`). A `links` field renders as one link per stored entry whose site the skin still offers: the site's icon, then the handle as the member wrote it, linking to the address the site's definition builds from it (see [Links](skin.md#links)), with `target="_blank"` and `rel="nofollow noopener noreferrer ugc"` as bio links have, and the site's name for screen readers. An entry whose site is gone, or whose handle no longer passes its site's rules, is kept and not shown. A private `links` field renders the same way, icons and all, in the admins' private section.
- **Avatars**: every profile image is served from `/avatar/<public id>` on our own domain, under a random per-photo uuid rather than an address-derived URL, because the endpoint is public and a hash in the path let anyone confirm a guessed address belongs to a member. Photos come from an upload or from Gravatar, fetched server-side and cached. See [Gravatar caching](#gravatar-caching-proxy) for the cache, its TTL, and the terms it answers to.
- **Profile editing** at `/members/<id>/edit` (own profile, or any profile for admins): field edits, affiliation checkboxes, a public-profile opt-in for the homepage showcase, photo upload, and profile deletion (removes the member row with its audit row, then the avatar, then revokes sessions). The form is read from the member row, and every write goes through `src/lib/server/member-write.ts`: one transaction that takes an advisory lock on the group, reads the row by its uuid under `FOR UPDATE`, applies the change and writes it with one `UPDATE` and an audit row. A field name the schema does not know is refused with `400`, and a private field is refused with `403` unless the caller is a group admin or the member. `name` is the first and last name joined on write; `city` is copied to its column. An uploaded photo's URL is stored in the private `bioPic` field by the same path. First login lands here as a "complete your profile" welcome step. The owner also picks a username here; see [Usernames](#usernames). A `links` field shows the saved rows and a **+** control: each row has a site picker (a combobox listing each site's icon beside its name, operable from the keyboard, offering only the sites no other row holds), a value box and a remove control. A pasted profile address becomes its handle when the box loses focus; the server repeats that reduction and its check is the one that decides. Without JavaScript each row is a native select and one blank row adds a link.

### Usernames

A member may choose a username, and their profile then lives at `/members/<username>` instead of `/members/<uuid>`. Nobody is given one: the uuid stays every member's id and default URL, nothing is generated from a name, and the skin's handle field is display text that is never copied into one.

**Rules.** One check, `checkUsername` in `src/lib/server/usernames.ts`, decides for the availability endpoint and the save action alike. A username is 3 to 30 characters and matches `^[a-z0-9]+(-[a-z0-9]+)*$` after surrounding spaces are trimmed and it is lowercased. It must be ASCII: a look-alike letter (Cyrillic `а`, fullwidth `Ａ`, an accented `é`) is refused, not folded to its ASCII twin, because a URL holding one points somewhere other than the name it reads as. It may not be all digits, may not be shaped like a uuid, and may not be reserved. The reserved list is every child route of `src/routes/group/[slug]/members/` (today `usernames`) plus `me`, `new`, `admin`, `api`, `login` and `logout`; a test fails when a new route segment there is missing from it. The column is citext under a unique index on `(group_id, username)`, so two spellings differing only in case are one name.

**Choosing one.** Only the member sets their own username, from the Username input on their edit page. About 400 ms after the last keystroke the page asks `GET /members/usernames?name=<typed>`, canceling any check still in flight, and shows one status in an `aria-live="polite"` line: available, taken, not allowed (naming the rule that failed), reserved, or already yours. The endpoint is members-only (the directory gate) and limited to 60 checks a minute per session (`429` past that). A limiter Redis cannot reach lets the check through, because the save decides again. The save runs the rule again and changes the username in the same transaction as the rest of the form, under the group's member-write lock, and the unique index has the last word: a name taken between the check and the save returns the form with "that username is taken" (`409`) and saves nothing. A group admin editing someone else gets no input, and a save posting one anyway is refused with `403`. Clearing the field removes the username and retires it.

**Redirects.** The `[id]` segment accepts a uuid, a current username or a retired one, in any case, on the clean URL and under `/group/<slug>/` alike. Only one form is canonical: the username if the member has one, else the uuid. The profile and edit pages answer any other form with `308` to the canonical URL, keeping the sub-route and the query, so `/members/<uuid>` goes to `/members/<username>` and a retired name goes to the current URL, whichever form that is. The star, avatar and passkey endpoints act on either form without redirecting. Every link the app builds (directory tiles and their stars, the profile's Edit and star, the sidebar's Profile and Settings, the edit page's photo and passkey endpoints, the redirect after a save) uses the canonical form. The homepage showcase links by username too, but only on the signed-in `/home` page for a member or admin, the one viewer whose showcase avatars are links: guests on the public landing and signed-in non-members get unlinked avatars and a payload with no username in it. A segment holding any non-ASCII character answers `404` before the lookup, on the profile and every sub-route, because the citext comparison would fold a look-alike such as the Kelvin sign (U+212A) into the ASCII name it imitates. Signed-out requests never reach the lookup: the hooks layer sends every `/members/…` path to `/login` before any query, so an existing name and a missing one get the same redirect. Reached by name, a profile the caller may not edit answers `404` on its edit, avatar and passkey routes whether or not the name exists, so a signed-in stranger cannot test names that way either; by uuid the old `403` stands.

**Retirement.** A name a member gives up, by changing or clearing it, is kept in `member_username_retired` against them. It keeps redirecting to them and no other member can claim it ("taken"). The owner can take it back by saving it again. A group admin sees the member's retired names on that member's edit page and can **Release** one, which ends its redirect and lets anyone claim it; the release is audited as `member.username-released`. Deleting the member deletes their retired names with them. A deletion submitted at `/members/<username>/edit` whose photo or session cleanup fails redirects to `/removal/<uuid>` itself, because the name it arrived by is gone and the removal page is keyed by uuid.

### Gravatar caching (proxy)

Members who never upload a photo often have one at [Gravatar](https://gravatar.com), keyed by their address. The app fetches it **server-side** and re-serves the bytes from `/avatar/<public id>`, so no visitor's browser ever contacts Automattic and no hash of anybody's address appears in a payload or a URL.

That direction is the point. A hotlinked `<img>` announces one member per image to a third party from the browser of whoever loaded the page, and it publishes the roster keyed by a hash that anyone holding a candidate address can confirm by hashing. One unauthenticated homepage load used to make 42 such requests.

| Piece                            | Where                               |
| -------------------------------- | ----------------------------------- |
| Hash + fetch + refresh schedule  | `src/lib/server/gravatar.ts`        |
| Row storage and the upload guard | `src/lib/server/avatars.ts`         |
| Serving, and the refresh trigger | `src/routes/avatar/[id]/+server.ts` |

**`member_avatar.source` says what a row holds.** The column exists because one table now serves two writers and only one of them may be overwritten.

| `source`   | Holds                          | Refreshed                        |
| ---------- | ------------------------------ | -------------------------------- |
| `upload`   | Bytes the member gave us       | **Never.** Their own choice wins |
| `gravatar` | Bytes fetched from Gravatar    | Past the TTL                     |
| `none`     | Nothing. Gravatar answered 404 | Past the TTL                     |

`none` is the negative cache and is not an optimization to skip. Most members have no Gravatar, so without a row recording the absence every render re-asks about all of them.

**Two things trigger a refresh, both tied to a real person.**

| Trigger                                  | Covers                                           |
| ---------------------------------------- | ------------------------------------------------ |
| A request for `/avatar/<public id>`      | Anyone actually being displayed on a page        |
| A member completing a magic-link sign-in | The member's own photo, the moment they are back |

The sign-in refresh exists because someone who has just changed their Gravatar should not wait out a seven-day TTL to see it. It refreshes an existing row and never creates one: anyone with an inbox can complete a magic link, and minting a Gravatar lookup for a stranger the app displays nowhere is a fetch on behalf of nobody.

**No request ever waits on Gravatar.** A row past its TTL is refreshed in the background and the handler serves whatever it already holds. A cold row 404s, which renders the initials disc, and the photo appears on the next load. `Gravatar.svelte` already paints the disc first and paints a photo over it, so the cold state is the designed one rather than a blank circle.

Refreshes are conditional. The stored `last_modified` goes back out as `If-Modified-Since`, and Gravatar answers `304` with an empty body when nothing changed; only `fetched_at` moves, so `updated_at` stays put and the browser ETag built from it does not churn. They send no `ETag`, so this is the only conditional they honor.

**The hash is sha256.** Gravatar's spec says "Don't use MD5!", and the weaker digest is also what makes confirming a guessed address cheap. `member_avatar` is still keyed by `md5(email)`: that one is an internal storage key, never leaves the server, and re-keying the table would rewrite every primary key to gain nothing. `gravatarHash` (sha256) lives in `src/lib/server/gravatar.ts` and `emailMd5` (storage) in `src/lib/server/avatars.ts`. They are separate on purpose.

#### Terms this has to answer to

Automattic's [API Terms of Use](https://developer.wordpress.com/guidelines/) cover the Gravatar API by name and permit the cache in writing: "Your app may cache or store WordPress.com content or data—but please refresh any data that you store at reasonable intervals." Four conditions come with it.

| Condition                           | How it is met                                          |
| ----------------------------------- | ------------------------------------------------------ |
| Refresh at a reasonable interval    | `TTL_MS`, 7 days                                       |
| Say what the app stores and retains | Copy under the photo picker on `/members/<id>/edit`    |
| Name Gravatar, with a link          | Same place. Text and a link, never their logo          |
| No excessive calls                  | 4 concurrent max; conditional refreshes; misses cached |
| Fetch for active users only         | A real image request, or the member's own sign-in      |

Gravatar serves `cache-control: max-age=300`, and the app deliberately overrides it. Honoring five minutes literally would re-ask about every member roughly 2,000 times a week, which is the excessive-calls clause. Their header is tuned for a browser holding one avatar, not a cache holding a roster.

The attribution is text plus a link because §3 bars using the Automattic or WordPress marks "without the express written consent and approval of Automattic". Naming the service is required; shipping their logo is not allowed.

## Routes

Clean URLs shown; each group page also exists at `/group/<slug>/…` (see [Clean URLs](#clean-urls-single-tenant-reroute)).

| Route                                | Access                       | Purpose                                                                                                                |
| ------------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `/`                                  | public                       | community landing page (Markdown)                                                                                      |
| `/home`                              | signed-in                    | the landing splash, viewable after sign-in                                                                             |
| `/manifesto`                         | public                       | Manifesto, from the skin's copy                                                                                        |
| `/code-of-conduct`                   | public                       | Code of Conduct, from the skin's copy                                                                                  |
| `/privacy`                           | public                       | Privacy notice, from the skin's copy                                                                                   |
| `/login`                             | public                       | magic-link email form                                                                                                  |
| `/auth/magic`                        | public                       | confirm the link (POST) or request a new one                                                                           |
| `/auth/passkey`                      | public, rate-limited         | passkey sign-in options and verify (POST)                                                                              |
| `/auth/email`                        | public                       | confirm or undo a sign-in email change (POST)                                                                          |
| `/logout`                            | signed-in                    | clear session (POST only)                                                                                              |
| `/request`                           | signed-in non-member         | membership request form                                                                                                |
| `/members`                           | member / admin               | searchable directory; `?q=` searches, `?<key>=` filters on each `filter: exact` field, `?starred=1` narrows to stars   |
| `/members/<id-or-username>`          | member / admin               | profile page, at the uuid or the member's username; the non-canonical form answers `308` (see [Usernames](#usernames)) |
| `/members/<id-or-username>/edit`     | profile owner / admin        | edit or delete the profile, choose a username                                                                          |
| `/members/<id-or-username>/passkeys` | profile owner                | list, register (POST) and remove (DELETE) passkeys                                                                     |
| `/members/<id-or-username>/email`    | profile owner                | request a sign-in email change (POST)                                                                                  |
| `/members/usernames`                 | member / admin, rate-limited | username availability check (GET `?name=`)                                                                             |
| `/admin`                             | group admin                  | member count, roster export links                                                                                      |
| `/admin/landing`                     | group admin                  | landing-page Markdown editor                                                                                           |
| `/admin/requests`                    | group admin                  | review membership requests (approve / deny)                                                                            |
| `/admin/audit`                       | group admin                  | the audit trail (read-only)                                                                                            |
| `/admin/export`                      | group admin                  | the roster as CSV (see "Roster export")                                                                                |
| `/avatar/[id]`                       | public, rate-limited         | avatar image (random per-photo id)                                                                                     |
| `/healthz`                           | public                       | health check                                                                                                           |

## Mail

Five messages leave this app (the sign-in link, the membership-request notice, the approval mail, and the confirmation and notice of a sign-in email change) and all five take one path:

```
src/lib/server/email.ts     composes subject + bodies + recipients
  └── mail.ts               picks the transport, owns the From: address
        └── smtp.ts         ESMTP submission to SMTP_HOST, port 587 by default
```

`email.ts` knows nothing about transport and `smtp.ts` knows nothing about content, which is the whole reason the split exists: a new message is one more object, not one more provider integration.

**Why mail is an availability concern here.** Sign-in is a magic link. A message in a spam folder is not a degraded experience, it is a user with no other way in, so anything that touches deliverability on the sending domain is an authentication change wearing different clothes.

The transport and its variables are in [configuration](configuration.md#mail); the DNS a sending domain needs is in [operations](operations.md#mail-dns).

### Message shape and encoding

Every message is `multipart/alternative` when it has both representations, and each part goes out **quoted-printable**. `src/lib/server/smtp.ts` builds the MIME itself; there is no library between the composer and the wire.

**Quoted-printable rather than base64 for text parts.** Base64 leaves a `text/*` body opaque to every filter, bounce report and maillog between here and the recipient, which is both unusual for legitimate mail and an obstacle to anything downstream trying to read it. Under quoted-printable the message is words on the wire. RFC 2047 encoded-words in headers still use base64 (`=?UTF-8?B?`), which is a different encoding in a different place and the right one there.

The encoder escapes `=` as `=3D`, emits multi-byte UTF-8 as octets (`Caf=C3=A9`), encodes trailing whitespace before a break as `=20` so a relay stripping it cannot invalidate the DKIM signature, and soft-breaks at 76 octets without ever splitting an `=XX` triplet.

**A leading dot is now reachable.** Quoted-printable preserves `.` at the start of a line, where base64 could never produce one. Unstuffed, that line reads as the end-of-data marker and the rest of the message is lost, so `dotStuff` (RFC 5321 §4.5.2) is doing real work on the DATA write rather than standing by.

**Every message carries `X-Mailer`, and the sign-in mail carries `Reply-To`.** `X-Mailer: lorem-host` is static and version-free: a message stamped by neither `X-Mailer` nor `User-Agent` is an outlier that scoring rules read as a bespoke script, and a version string here would name the deployed release to everyone who receives a message. `Reply-To` on the sign-in mail points at `COMPANY_SUPPORT_EMAIL`, because the person most likely to reply to a sign-in link is one who never requested it. `From:` stays on the signed domain either way, so DMARC alignment is unaffected.

**The sign-in mail carries a plain-text part.** It is written, not derived: the vendored template is 6 KB of table markup around under 300 bytes of prose, so a converter would produce wreckage. Composition lives in `src/lib/server/magic-link-message.ts`, which takes the deployment's base URL and company name as arguments so it holds no `$env` import and stays loadable by a test.

**Three things are stripped from the vendored template at send time**, rather than edited into `magic-link-template.ts`, which carries a "do not hand-edit" notice and must stay byte-for-byte re-renderable from its Maizzle source. A send-time rewrite also survives a re-render, where a hand-edit would be reverted by it.

| Stripped                         | Why                                                                                                                                                                              |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 150 × `&#847;` preheader padding | U+034F renders as nothing, so this is 900 bytes of invisible text. A long run of it is what content filters treat as hidden text. The visible preheader sentence is kept         |
| 3 × Google Fonts `<link>`        | The template requests Roboto Slab and no rule applies it: every `font-family` names 'Segoe UI' or the system stack. Three third-party requests for a face the message never uses |
| 1 × `application/ld+json` block  | A schema.org `EmailMessage` annotation. Gmail alone acts on one and only for a registered sender, so it is inert while putting a `<script>` element in a message                 |

All three are pinned by `magic-link-message.test.ts`. For the padding and the annotation that includes a test that fails if the template is re-vendored without them, so a strip cannot quietly become a no-op protecting nothing.

**The font links are the one exception to byte-for-byte.** The vendored copy leaves the three tags out, and its header says so, because the acceptance check for removing the Google API client is a text search of `src/` and `scripts/` for the package name, and the fonts hostname contains it. A re-render from the Maizzle source brings them back; delete them again. The send-time strip still runs and matches a `<link>` to any host that starts with `fonts.`, so a re-render that kept them would still send none, and the tests re-insert three such tags to hold that.

The annotation's `publisher` named the template's author, in a message whose `From:` is this deployment's own domain: structured data disagreeing with the envelope. The skin's optional `mail.credit` line is where a visible credit belongs (see [skins](skin.md#mail)). The block also held two copies of the sign-in URL, so the strip is matched on the `<script>` element rather than on its contents and a test asserts the button's `href` survives it.

This shape was arrived at after a sign-in mail landed in a Gmail spam folder with SPF, DKIM and DMARC all passing. Nothing here is proof of a cause: for a domain with almost no sending history the classifier's judgment is mostly reputation, and it is opaque. These were the parts that were wrong on their own terms.
