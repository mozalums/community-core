# Data model

What the platform stores, where, and which file decides its shape. Postgres holds all of it; Redis holds only sessions and sign-in tokens, which a member recreates by signing in again.

## Source of truth

**Postgres is the roster, and the only store.** A member row comes from one of two places: an admin approving a membership request, or a roster import.

- **Profile edits** are saved to Postgres through `member-write.ts`.
- **Deleting a profile** removes the member row; the delete fails, with nothing removed, if that does. The avatar and the sessions follow, each best-effort.
- **Bulk edits** are a CSV round trip: see [roster export](features.md#roster-export) and [roster import](features.md#roster-import).

Migration 15 dropped the columns and the table an earlier spreadsheet sync wrote (`group.sheet_id`, `group.sheet_range`, `group.column_map`, `sync_run`, `member.source_row` and `member.synced_at`). A new database creates and drops them in its first migration run.

## Data model

The tables, as `src/lib/server/migrations.ts` leaves them:

- **`group`**: `slug`, `name`, `landing_md`, `status`
- **`member`**: `group_id`, `email` (citext, unique per group), `ident_subject`, `name`, `city`, `linkedin`, `data`, `private_data`, `status`, `username` (citext, nullable, unique per group), `identity_epoch` (bigint), and a generated `search_tsv` (full-text over the values in `data`)
  - `identity_epoch` changes, from the `member_identity_epoch_seq` sequence, on every row of an account each time its sign-in address moves. A sign-in email change link carries the value it was requested under and is refused once it differs. See [sign-in email change](features.md#sign-in-email-change).
  - `username` is the profile URL name a member chose, null until they choose one; the uuid `id` stays the default URL. See [usernames](features.md#usernames).
  - `data` (jsonb) holds the members-visible profile fields and `private_data` (jsonb) the admin-only ones, both keyed by field key. Search reads `data` and never `private_data`, so where a field is stored is what keeps it out of search.
  - `name`, `city` and `linkedin` are the typed columns: each joins, with a space, the values of the fields whose `column` names it, in field order (a `givenName` and a `familyName` field, say). Approval sets all three; a profile save rebuilds only the columns whose fields it changed, so an edit to Bio leaves a name alone. The parts stay in `data`, since a join is irreversible.
  - The edit form fills a typed column's controls from the typed value only when none of that column's fields is stored, so a stored part is never joined twice on save.
  - Migration 15 dropped `source_row` and `synced_at`, which only the spreadsheet sync wrote, and `visibility`, which had no reader since migration 1. The field's `visibility` in `skin.yaml` is the concept that replaced that column.
- **`group_admin`**: `group_id`, `ident_subject`, `email`
- **`access_request`**: `group_id`, `email`, `ident_subject`, `name`, `data` (jsonb, keyed like `member.data` and holding private values too, split on approval), `status` (`pending`, `approved` or `denied`), `decided_at`, `decided_by`, `deny_reason`, `created_at`, `updated_at`; at most one pending row per address per group
- **`member_avatar`**: uploaded and cached photos, keyed by `email_md5` (not per group: an address owns its avatar), plus a random `public_id` that is the photo's public URL. The md5 is a storage key and never leaves the server.
- **`member_star`**: `(group_id, starrer subject, member_id)`
- **`member_username_retired`**: `(group_id, username, member_id, retired_at)`, keyed on `(group_id, username)`: every username a member gave up, which still redirects to them and which no other member can claim until a group admin releases it. Deleted with the member. No index spans it and `member.username`; the write path keeps a name out of both at once under the group's member-write lock.
- **`email_revert_grant`**: `id`, `member_ids` (uuid[]), `restore_to`, `epoch`, `expires_at`, `spent_at`: one per confirmed sign-in email change, the authority behind the undo link mailed to the old address. A member row inserted at an address one of the listed rows holds is appended to `member_ids` by the `member_joins_revert_grants` trigger. Spent by its own undo, voided by an undo of an earlier change or by the operator recovery script, and deleted by the next confirmed change once expired.
- **`member_import_plan`**: a roster import's parsed rows between preview and apply, deleted once applied or after an hour
- **`audit_event`**: one row per recorded change, every subsystem; see [audit trail](features.md#audit-trail)
- **`schema_migrations`**: the migration ledger, written by `pnpm migrate` or by the app at boot

Migrations run forward only, inside one transaction per run, under an advisory lock. [Deployment](deployment.md#migrations) covers how they are applied, and [upgrading](upgrading.md) what a release may change.

## Member fields

The fields are defined once, under the `fields` key of the skin's `skin.yaml` ([skins](skin.md) is the format reference): an ordered list of `key`, `label`, `type`, `visibility` (`members` or `private`), an optional `role` and an optional promoted `column`. Code reaches the list as `DEFAULT_FIELD_SCHEMA` in `src/lib/server/field-schema.ts`, which reads the skin selected by `SKIN_DIR`. The label is both the form label and the CSV column heading.

Code finds a field by its `role`, never by key or label: the directory's year filter reads the `tenureStart` and `tenureEnd` fields, the profile groups the `affiliation` fields under "Associated with", and the public homepage reads the `publicProfile` field. A skin must name its members, with one `name` field or with a `givenName` and a `familyName` field; a skin without one of the other roles has that feature off. The edit form, the profile page and the request card all render from this list in its order.

The schema is a reviewed file rather than a database column because it sets the privacy boundary. Visibility applies to a field's promoted column too: the address sits in `member.email`, but a private `email` field is shown to group admins only.

`skin/default` declares five fields:

| Key       | Label   | Stored in      | Role   |
| --------- | ------- | -------------- | ------ |
| `name`    | Name    | `data`         | `name` |
| `country` | Country | `data`         |        |
| `city`    | City    | `data`         |        |
| `bio`     | Bio     | `data`         | `bio`  |
| `phone`   | Phone   | `private_data` |        |

**`x.<original header>`** keys hold any imported column the schema does not declare, under its original heading. An undeclared column is stored in `private_data`, because an unreviewed column could hold anything, and the schema loader synthesizes a private definition for each `x.*` key, so admins see it on the profile after every declared field and members never do. Nothing is dropped.

Adding a field is an edit to the skin's `fields`. Renaming a key needs a migration that rewrites the stored data, since stored keys do not follow the schema on their own.

Migration 13 re-keyed one community's rows from spreadsheet headings to field keys and has since lost the table that did it. On any other database it adds `private_data` and rebuilds search; on a database whose `member` or `access_request` rows still hold heading-keyed data it refuses and changes nothing.

Migration 17 installs the `unaccent` extension and `search_unaccent(text)`, an `IMMUTABLE` wrapper that names its dictionary by schema, so an index can be built on it where the stock `STABLE` `unaccent()` cannot back one. Search compares through it and stored values are never rewritten.

## Not yet covered

- The field schema is per deployment, not per group: one deployment serves one group.
- No operation erases a member from the audit trail before its retention window ends. [Audit trail](features.md#retention-versus-erasure) states the conflict.
