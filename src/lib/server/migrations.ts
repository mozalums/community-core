// Pure migration engine — no SvelteKit/$env imports so it can run both
// inside the app (via schema.ts) and from plain `tsx` scripts (migrate.ts,
// seed.ts). Cyan-web shipped no migration tooling; lorem.host owns its
// schema as an ordered, idempotent ledger applied under a Postgres advisory
// lock so concurrent app boots / script runs can't race.

import type pg from 'pg';
import { currentSkin } from '../skin/load';
import type { SkinField } from '../skin/schema';
import { coreSite, reduceLink, storedLinks } from '../links';

// Arbitrary but fixed 64-bit key for pg_advisory_lock. Don't change it.
const ADVISORY_LOCK_KEY = 4_607_001;

// `run` is a step SQL cannot state without a second copy of a rule core keeps
// in TypeScript. It runs first, on the migration's own transaction, and
// returns a line for the operator.
export type Migration = {
	version: number;
	name: string;
	sql: string;
	run?: (client: pg.ClientBase) => Promise<string>;
};

// Where migration 22 keeps a LinkedIn value that is neither a LinkedIn profile
// nor a usable website address: a private key no field declares, so admins see
// it in the private export and search never reads it. report-bad-profile-urls
// lists each one for an admin to fix by hand.
export const UNCONVERTED_LINKEDIN_KEY = 'x.linkedin';

type Bag = Record<string, unknown>;

export type LinkedinOutcome = 'linkedin' | 'website' | 'kept' | 'none';

// One row's LinkedIn value moved into the skin's links field. The column is
// the source of truth; `data.linkedin` is the copy a save wrote beside it and
// is read only when the column is empty. A value that is not a LinkedIn profile
// but is an https address becomes the member's website link; anything else is
// kept privately rather than dropped.
export function convertLinkedinValue(
	column: string | null,
	bags: { data: Bag; privateData: Bag },
	fields: readonly SkinField[]
): LinkedinOutcome {
	const copy = bags.data.linkedin;
	delete bags.data.linkedin;
	delete bags.privateData.linkedin;
	const raw = (column ?? '').trim() || (typeof copy === 'string' ? copy.trim() : '');
	if (!raw) return 'none';

	const field = fields.find((f) => f.type === 'links' && f.sites?.includes('linkedin'));
	const bag = field?.visibility === 'members' ? bags.data : bags.privateData;
	const entries = field ? storedLinks(bag[field.key]) : [];
	// True only when the value ends up stored: a different entry the member
	// already holds for that site wins, and the value is kept for the report.
	const add = (site: 'linkedin' | 'website'): boolean => {
		if (!field || !(field.sites ?? []).includes(site)) return false;
		const c = reduceLink(coreSite(site)!, raw);
		if (!c.ok) return false;
		const held = entries.find((e) => e.site === site);
		if (held) return held.handle === c.handle;
		entries.push({ site, handle: c.handle });
		bag[field.key] = entries;
		return true;
	};
	const isProfile = reduceLink(coreSite('linkedin')!, raw).ok;
	if (isProfile && add('linkedin')) return 'linkedin';
	// The website form assumes https:// for a bare host; a legacy value only
	// moves there when it already is an https address and not a LinkedIn
	// profile that lost to the member's own link.
	if (!isProfile && /^https:\/\//i.test(raw) && add('website')) return 'website';
	bags.privateData[UNCONVERTED_LINKEDIN_KEY] = raw;
	return 'kept';
}

export async function convertLinkedin(
	client: pg.ClientBase,
	fields: readonly SkinField[] = currentSkin().skin.fields
): Promise<string> {
	const tally: Record<LinkedinOutcome, number> = { linkedin: 0, website: 0, kept: 0, none: 0 };
	const members = await client.query<{
		id: string;
		linkedin: string | null;
		data: Bag | null;
		private_data: Bag | null;
	}>(
		`SELECT id, linkedin, data, private_data FROM member
		  WHERE coalesce(btrim(linkedin), '') <> '' OR data ? 'linkedin' OR private_data ? 'linkedin'`
	);
	for (const m of members.rows) {
		const bags = { data: m.data ?? {}, privateData: m.private_data ?? {} };
		tally[convertLinkedinValue(m.linkedin, bags, fields)]++;
		await client.query(
			`UPDATE member SET data = $2::jsonb, private_data = $3::jsonb WHERE id = $1`,
			[m.id, JSON.stringify(bags.data), JSON.stringify(bags.privateData)]
		);
	}
	// A request keeps one bag, private values included; approval splits it.
	const requests = await client.query<{ id: string; data: Bag }>(
		`SELECT id, data FROM access_request WHERE data ? 'linkedin'`
	);
	for (const r of requests.rows) {
		tally[convertLinkedinValue(null, { data: r.data, privateData: r.data }, fields)]++;
		await client.query(`UPDATE access_request SET data = $2::jsonb WHERE id = $1`, [
			r.id,
			JSON.stringify(r.data)
		]);
	}
	return (
		`migration 22: ${tally.linkedin} LinkedIn value(s) converted, ${tally.website} moved to the website link, ` +
		`${tally.kept} kept under ${UNCONVERTED_LINKEDIN_KEY} (pnpm report-bad-profile-urls lists them)`
	);
}

// Append-only. Never edit or renumber an applied migration — add a new one.
export const MIGRATIONS: Migration[] = [
	{
		version: 1,
		name: 'init',
		sql: /* sql */ `
			CREATE EXTENSION IF NOT EXISTS pgcrypto;
			CREATE EXTENSION IF NOT EXISTS citext;
			CREATE EXTENSION IF NOT EXISTS pg_trgm;

			CREATE TABLE IF NOT EXISTS "group" (
				id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				slug        text UNIQUE NOT NULL,
				name        text NOT NULL,
				sheet_id    text,
				sheet_range text NOT NULL DEFAULT 'Members',
				landing_md  text,
				status      text NOT NULL DEFAULT 'active',
				created_at  timestamptz NOT NULL DEFAULT now(),
				updated_at  timestamptz NOT NULL DEFAULT now()
			);

			CREATE TABLE IF NOT EXISTS member (
				id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				group_id      uuid NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
				email         citext NOT NULL,
				ident_subject text,
				name          text,
				city          text,
				linkedin      text,
				data          jsonb NOT NULL DEFAULT '{}'::jsonb,
				visibility    jsonb NOT NULL DEFAULT '{}'::jsonb,
				status        text NOT NULL DEFAULT 'active',
				source_row    int,
				synced_at     timestamptz,
				created_at    timestamptz NOT NULL DEFAULT now(),
				UNIQUE (group_id, email)
			);

			ALTER TABLE member ADD COLUMN IF NOT EXISTS search_tsv tsvector
				GENERATED ALWAYS AS (
					to_tsvector('simple',
						coalesce(name,'') || ' ' || coalesce(city,'') || ' ' ||
						coalesce(linkedin,'') || ' ' || coalesce(data::text,''))
				) STORED;

			CREATE INDEX IF NOT EXISTS member_group_active_idx
				ON member(group_id) WHERE status = 'active';
			CREATE INDEX IF NOT EXISTS member_city_trgm_idx
				ON member USING gin (city gin_trgm_ops);
			CREATE INDEX IF NOT EXISTS member_name_trgm_idx
				ON member USING gin (name gin_trgm_ops);
			CREATE INDEX IF NOT EXISTS member_search_tsv_idx
				ON member USING gin (search_tsv);
			CREATE INDEX IF NOT EXISTS member_ident_subject_idx
				ON member(group_id, ident_subject);

			CREATE TABLE IF NOT EXISTS group_admin (
				group_id      uuid NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
				ident_subject text NOT NULL,
				email         citext,
				created_at    timestamptz NOT NULL DEFAULT now(),
				PRIMARY KEY (group_id, ident_subject)
			);

			CREATE TABLE IF NOT EXISTS access_request (
				id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				group_id          uuid NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
				email             citext NOT NULL,
				ident_subject     text,
				name              text,
				message           text,
				status            text NOT NULL DEFAULT 'pending',
				sheet_appended_at timestamptz,
				created_at        timestamptz NOT NULL DEFAULT now()
			);
			CREATE UNIQUE INDEX IF NOT EXISTS access_request_pending_uniq
				ON access_request(group_id, email) WHERE status = 'pending';

			CREATE TABLE IF NOT EXISTS sync_run (
				id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				group_id    uuid NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
				started_at  timestamptz NOT NULL DEFAULT now(),
				finished_at timestamptz,
				status      text NOT NULL DEFAULT 'running',
				rows_seen   int,
				upserted    int,
				removed     int,
				error       text
			);
			CREATE INDEX IF NOT EXISTS sync_run_group_started_idx
				ON sync_run(group_id, started_at DESC);
		`
	},
	{
		version: 2,
		name: 'group_column_map',
		sql: /* sql */ `
			-- Maps member fields → source-sheet header names, e.g.
			-- {"email":"Email","name":"Full Name","city":"City",
			--  "linkedin":"LinkedIn URL"}. Headers not listed here flow into
			-- member.data (jsonb). Empty {} = use defaults (header == field).
			ALTER TABLE "group"
				ADD COLUMN IF NOT EXISTS column_map jsonb NOT NULL DEFAULT '{}'::jsonb;
		`
	},
	{
		version: 3,
		name: 'member_avatar',
		sql: /* sql */ `
			-- Self-hosted profile photos. Keyed by md5(lowercased email) — the same
			-- hash Gravatar uses — so the image serves at /avatar/<md5>, mirroring the
			-- Gravatar path on our own domain. Not tied to a group/member row: an
			-- email owns its avatar (matches how logins + Gravatar key on email).
			CREATE TABLE IF NOT EXISTS member_avatar (
				email_md5    text PRIMARY KEY,
				email        citext NOT NULL,
				bytes        bytea NOT NULL,
				content_type text NOT NULL,
				updated_at   timestamptz NOT NULL DEFAULT now()
			);
		`
	},
	{
		version: 4,
		name: 'member_star',
		sql: /* sql */ `
			-- Per-user "starred people": which members a signed-in user has starred.
			-- starrer is the session subject (email:<addr>) — no FK, since it may be a
			-- dash-access non-member. member_id is the starred member.
			CREATE TABLE IF NOT EXISTS member_star (
				group_id   uuid NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
				starrer    text NOT NULL,
				member_id  uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
				created_at timestamptz NOT NULL DEFAULT now(),
				PRIMARY KEY (group_id, starrer, member_id)
			);
			CREATE INDEX IF NOT EXISTS member_star_starrer_idx
				ON member_star(group_id, starrer);
		`
	},
	{
		version: 5,
		name: 'group_doc_content',
		sql: /* sql */ `
			-- Per-group Manifesto + Code of Conduct Markdown, ingested from the
			-- community's Google Doc tabs (scripts/load-docs.ts) and rendered like
			-- landing_md via markdown-it. Nullable; pages fall back to a placeholder.
			ALTER TABLE "group"
				ADD COLUMN IF NOT EXISTS manifesto_md text,
				ADD COLUMN IF NOT EXISTS code_of_conduct_md text;
		`
	},
	{
		version: 6,
		name: 'search_tsv_values_only',
		sql: /* sql */ `
			-- Rebuild search_tsv from data VALUES only, not data::text. Serializing
			-- the jsonb to text embedded the column *keys* (each affiliation
			-- checkbox, Country, …), so a full-text search for any header name
			-- matched every member: a query naming an affiliation returned everyone,
			-- not just members with that box checked.
			-- The values-only helper also drops sensitive columns (postal/phone/
			-- messaging) and boolean checkbox cells, mirroring the value-search clause
			-- in searchMembers (and closing an incidental leak of private values into
			-- full-text search). Affiliation membership is matched by the separate
			-- checkbox-key clause, so nothing is lost.
			CREATE OR REPLACE FUNCTION member_search_values(d jsonb) RETURNS text
				LANGUAGE sql IMMUTABLE AS $$
					SELECT coalesce(string_agg(value, ' '), '')
					FROM jsonb_each_text(d)
					WHERE lower(key) !~ 'postal|address|whatsapp|signal|slack|mailing|dash|phone|email'
					  AND lower(btrim(value)) NOT IN
					      ('true', 'false', 'yes', 'no', 'y', 'n', 'x', '1', '0', 'checked', 'on')
				$$;

			ALTER TABLE member DROP COLUMN IF EXISTS search_tsv;
			ALTER TABLE member ADD COLUMN search_tsv tsvector
				GENERATED ALWAYS AS (
					to_tsvector('simple',
						coalesce(name, '') || ' ' || coalesce(city, '') || ' ' ||
						coalesce(linkedin, '') || ' ' || member_search_values(data))
				) STORED;

			CREATE INDEX IF NOT EXISTS member_search_tsv_idx
				ON member USING gin (search_tsv);
		`
	},
	{
		version: 7,
		name: 'member_avatar_public_id',
		sql: /* sql */ `
			-- Public URL key for a stored photo, replacing md5(email) in /avatar/<…>.
			-- The endpoint is unauthenticated by design (the landing showcase and the
			-- sheet's Bio Pic column both link it), and an address-derived URL made it
			-- a membership oracle: hash a guessed address, read the answer off the
			-- status code. A random id per photo is unguessable and says nothing about
			-- the address that owns it. email_md5 stays the primary key — it is how a
			-- writer finds the row from an address, and it never leaves the server.
			-- The default is volatile, so every existing row gets its own id.
			ALTER TABLE member_avatar
				ADD COLUMN IF NOT EXISTS public_id uuid NOT NULL DEFAULT gen_random_uuid();

			CREATE UNIQUE INDEX IF NOT EXISTS member_avatar_public_id_idx
				ON member_avatar(public_id);
		`
	},
	{
		version: 8,
		name: 'access_request_decided_at',
		sql: /* sql */ `
			-- When a request stopped being pending. The Requests tab records a
			-- decision by deleting the row, so nothing carried the timestamp; a
			-- decision recorded in Postgres keeps the row and needs one.
			ALTER TABLE access_request
				ADD COLUMN IF NOT EXISTS decided_at timestamptz;
		`
	},
	{
		version: 9,
		name: 'member_avatar_gravatar_cache',
		sql: /* sql */ `
			-- The table now holds two kinds of row, so it has to say which. A cached
			-- Gravatar and an uploaded photo are both bytes at /avatar/<public_id>,
			-- but only one of them may be overwritten by a refresh: an upload is the
			-- member's own decision and outranks whatever Gravatar serves.
			--   upload   bytes the member gave us. Never refreshed, never replaced.
			--   gravatar bytes fetched from Gravatar. Refreshed past the TTL.
			--   none     Gravatar answered 404. The negative cache — without a row
			--            here, every render re-asks for the majority of members who
			--            will never have one.
			ALTER TABLE member_avatar
				ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'upload';

			-- When Gravatar was last ASKED, which is not when the bytes last changed.
			-- A 304 moves this and leaves updated_at alone, so revalidation costs no
			-- bytes and does not invalidate the browser ETag built from updated_at.
			ALTER TABLE member_avatar
				ADD COLUMN IF NOT EXISTS fetched_at timestamptz;

			-- Gravatar's Last-Modified, echoed back as If-Modified-Since. They send
			-- no ETag, so this is the only conditional request they honour.
			ALTER TABLE member_avatar
				ADD COLUMN IF NOT EXISTS last_modified text;

			-- Every row predating this migration is an upload: it is the only writer
			-- that existed. Stated rather than left to the column default, because
			-- the default is for new rows and this is a claim about old ones.
			UPDATE member_avatar SET source = 'upload' WHERE source IS NULL;

			-- 'none' rows carry no bytes, so the NOT NULL that suited an upload-only
			-- table has to go. content_type follows for the same reason.
			ALTER TABLE member_avatar ALTER COLUMN bytes DROP NOT NULL;
			ALTER TABLE member_avatar ALTER COLUMN content_type DROP NOT NULL;

			-- Drives the refresh sweep: find rows this address needs re-asked about.
			CREATE INDEX IF NOT EXISTS member_avatar_refresh_idx
				ON member_avatar(source, fetched_at);
		`
	},
	{
		version: 10,
		name: 'audit_event',
		sql: /* sql */ `
			-- Who changed what, for every subsystem. A new subsystem adds an
			-- action string, never a column; category exists only to choose a
			-- retention window (audit-core.ts), so it is a closed set.
			--
			-- group_id is SET NULL, not CASCADE, and group_slug is copied beside
			-- it: deleting a community must not erase the record of who had access
			-- to it, which is the moment that record is needed most. Targets carry
			-- no foreign key at all for the same reason — a member row is deleted,
			-- and the row recording the deletion has to survive it.
			CREATE TABLE IF NOT EXISTS audit_event (
				id             bigserial PRIMARY KEY,
				at             timestamptz NOT NULL DEFAULT now(),
				category       text NOT NULL
					CHECK (category IN ('authz', 'membership', 'content', 'data', 'system')),
				action         text NOT NULL,
				actor_subject  text,
				actor_email    citext,
				group_id       uuid REFERENCES "group"(id) ON DELETE SET NULL,
				group_slug     text,
				target_email   citext,
				target_subject text,
				target_id      text,
				before         jsonb,
				after          jsonb,
				meta           jsonb NOT NULL DEFAULT '{}'::jsonb,
				run_id         uuid
			);
			CREATE INDEX IF NOT EXISTS audit_event_group_at_idx
				ON audit_event(group_id, at DESC);
			CREATE INDEX IF NOT EXISTS audit_event_target_email_idx
				ON audit_event(target_email);
			CREATE INDEX IF NOT EXISTS audit_event_run_idx
				ON audit_event(run_id) WHERE run_id IS NOT NULL;
			-- Drives the prune: one range scan per category window.
			CREATE INDEX IF NOT EXISTS audit_event_category_at_idx
				ON audit_event(category, at);
		`
	},
	{
		version: 11,
		name: 'group_admin_from_dash_permissions',
		sql: /* sql */ `
			-- Admin grants used to be read from each member's synced "Dash
			-- Permissions" cell. The app stops reading it in this release, so every
			-- grant that cell carried is copied into group_admin once, here, keyed by
			-- the subject a magic-link session for that address carries.
			--
			-- This is a frozen port of the JavaScript that decided those grants
			-- (resolveHeader, normHeader and isAdminValue as they stood, reading
			-- member.data the way node-postgres parsed it). Literal rather than
			-- imported, because this text must not change after it has been
			-- applied anywhere. Each rule below is one the old code applied:
			--
			--   * Header spec: column_map.dashPermissions when JS-truthy, else
			--     "Dash Permissions". A string is a one-item list. An array holding
			--     anything but strings, or any other truthy value, made the old
			--     code throw, which it answered with "not an admin".
			--   * Header match: whitespace runs collapsed to one space, trimmed,
			--     lowercased. "Whitespace" is JavaScript's \\s set, written out
			--     because Postgres's \\s depends on the locale and misses U+00A0.
			--   * The first spec entry with any matching key wins; among keys that
			--     normalize alike, the LAST one in jsonb key order wins, because the
			--     old code built a Map over Object.keys and later keys overwrote
			--     earlier ones. Object.keys order is jsonb's stored order here: the
			--     only keys JavaScript reorders are array indices, and an index
			--     always sorts before any longer key that normalizes to it.
			--   * Cell: String(value). For an array that joins its elements with
			--     ",", which is a separator anyway, so the string leaves reached
			--     through nested arrays are what count. Other non-strings never
			--     spelled a role.
			--   * Role: split on , and ;, trim JavaScript whitespace, lowercase,
			--     compare to admin, owner or superadmin.
			--   * Email subject: "email:" plus the lowercased address.
			--
			-- "Lowercased" means String.prototype.toLowerCase on Node 22.23.2
			-- (Unicode 17.0, ICU 78.2), the runtime that decided these grants.
			-- Neither lower() nor an ICU collation reproduces it: glibc maps U+0130
			-- to a bare "i", and Postgres's ICU can predate a Unicode release
			-- (U+1C89 lowercases to U+1C8A in 16.0 and to itself before). So the
			-- mapping is frozen below as data, generated from that runtime:
			--
			--   * lc_runs: every code point whose lowercase is one code point, as
			--     FIRST-LAST/STEP+DELTA runs. Only U+0130 lowercases to two
			--     (i, U+0307) and is handled on its own.
			--   * Final_Sigma: U+03A3 lowercases to U+03C2 when a cased letter
			--     precedes it and none follows, skipping case-ignorable characters
			--     on both sides; elsewhere to U+03C3. lc_cased lists the cased code
			--     points that are not also case-ignorable (ICU skips those), and
			--     lc_ignorable the case-ignorable ones.
			DO $$
			DECLARE
				admins_before bigint;
				admins_after  bigint;
				lc_runs constant text := '
					0041-005A/1+32 00C0-00D6/1+32 00D8-00DE/1+32 0100-012E/2+1 0132-0136/2+1 0139-0147/2+1
					014A-0176/2+1 0178-0178/1-121 0179-017D/2+1 0181-0181/1+210 0182-0184/2+1 0186-0186/1+206
					0187-0187/1+1 0189-018A/1+205 018B-018B/1+1 018E-018E/1+79 018F-018F/1+202 0190-0190/1+203
					0191-0191/1+1 0193-0193/1+205 0194-0194/1+207 0196-0196/1+211 0197-0197/1+209 0198-0198/1+1
					019C-019C/1+211 019D-019D/1+213 019F-019F/1+214 01A0-01A4/2+1 01A6-01A6/1+218 01A7-01A7/1+1
					01A9-01A9/1+218 01AC-01AC/1+1 01AE-01AE/1+218 01AF-01AF/1+1 01B1-01B2/1+217 01B3-01B5/2+1
					01B7-01B7/1+219 01B8-01B8/1+1 01BC-01BC/1+1 01C4-01C4/1+2 01C5-01C5/1+1 01C7-01C7/1+2
					01C8-01C8/1+1 01CA-01CA/1+2 01CB-01DB/2+1 01DE-01EE/2+1 01F1-01F1/1+2 01F2-01F4/2+1
					01F6-01F6/1-97 01F7-01F7/1-56 01F8-021E/2+1 0220-0220/1-130 0222-0232/2+1 023A-023A/1+10795
					023B-023B/1+1 023D-023D/1-163 023E-023E/1+10792 0241-0241/1+1 0243-0243/1-195 0244-0244/1+69
					0245-0245/1+71 0246-024E/2+1 0370-0372/2+1 0376-0376/1+1 037F-037F/1+116 0386-0386/1+38
					0388-038A/1+37 038C-038C/1+64 038E-038F/1+63 0391-03A1/1+32 03A3-03AB/1+32 03CF-03CF/1+8
					03D8-03EE/2+1 03F4-03F4/1-60 03F7-03F7/1+1 03F9-03F9/1-7 03FA-03FA/1+1 03FD-03FF/1-130
					0400-040F/1+80 0410-042F/1+32 0460-0480/2+1 048A-04BE/2+1 04C0-04C0/1+15 04C1-04CD/2+1
					04D0-052E/2+1 0531-0556/1+48 10A0-10C5/1+7264 10C7-10C7/1+7264 10CD-10CD/1+7264 13A0-13EF/1+38864
					13F0-13F5/1+8 1C89-1C89/1+1 1C90-1CBA/1-3008 1CBD-1CBF/1-3008 1E00-1E94/2+1 1E9E-1E9E/1-7615
					1EA0-1EFE/2+1 1F08-1F0F/1-8 1F18-1F1D/1-8 1F28-1F2F/1-8 1F38-1F3F/1-8 1F48-1F4D/1-8
					1F59-1F5F/2-8 1F68-1F6F/1-8 1F88-1F8F/1-8 1F98-1F9F/1-8 1FA8-1FAF/1-8 1FB8-1FB9/1-8
					1FBA-1FBB/1-74 1FBC-1FBC/1-9 1FC8-1FCB/1-86 1FCC-1FCC/1-9 1FD8-1FD9/1-8 1FDA-1FDB/1-100
					1FE8-1FE9/1-8 1FEA-1FEB/1-112 1FEC-1FEC/1-7 1FF8-1FF9/1-128 1FFA-1FFB/1-126 1FFC-1FFC/1-9
					2126-2126/1-7517 212A-212A/1-8383 212B-212B/1-8262 2132-2132/1+28 2160-216F/1+16 2183-2183/1+1
					24B6-24CF/1+26 2C00-2C2F/1+48 2C60-2C60/1+1 2C62-2C62/1-10743 2C63-2C63/1-3814 2C64-2C64/1-10727
					2C67-2C6B/2+1 2C6D-2C6D/1-10780 2C6E-2C6E/1-10749 2C6F-2C6F/1-10783 2C70-2C70/1-10782 2C72-2C72/1+1
					2C75-2C75/1+1 2C7E-2C7F/1-10815 2C80-2CE2/2+1 2CEB-2CED/2+1 2CF2-2CF2/1+1 A640-A66C/2+1
					A680-A69A/2+1 A722-A72E/2+1 A732-A76E/2+1 A779-A77B/2+1 A77D-A77D/1-35332 A77E-A786/2+1
					A78B-A78B/1+1 A78D-A78D/1-42280 A790-A792/2+1 A796-A7A8/2+1 A7AA-A7AA/1-42308 A7AB-A7AB/1-42319
					A7AC-A7AC/1-42315 A7AD-A7AD/1-42305 A7AE-A7AE/1-42308 A7B0-A7B0/1-42258 A7B1-A7B1/1-42282 A7B2-A7B2/1-42261
					A7B3-A7B3/1+928 A7B4-A7C2/2+1 A7C4-A7C4/1-48 A7C5-A7C5/1-42307 A7C6-A7C6/1-35384 A7C7-A7C9/2+1
					A7CB-A7CB/1-42343 A7CC-A7DA/2+1 A7DC-A7DC/1-42561 A7F5-A7F5/1+1 FF21-FF3A/1+32 10400-10427/1+40
					104B0-104D3/1+40 10570-1057A/1+39 1057C-1058A/1+39 1058C-10592/1+39 10594-10595/1+39 10C80-10CB2/1+64
					10D50-10D65/1+32 118A0-118BF/1+32 16E40-16E5F/1+32 16EA0-16EB8/1+27 1E900-1E921/1+34';
				lc_cased constant text := '
					0041-005A 0061-007A 00AA 00B5 00BA 00C0-00D6 00D8-00F6 00F8-01BA
					01BC-01BF 01C4-0293 0296-02AF 0370-0373 0376-0377 037B-037D 037F 0386
					0388-038A 038C 038E-03A1 03A3-03F5 03F7-0481 048A-052F 0531-0556 0560-0588
					10A0-10C5 10C7 10CD 10D0-10FA 10FD-10FF 13A0-13F5 13F8-13FD 1C80-1C8A
					1C90-1CBA 1CBD-1CBF 1D00-1D2B 1D6B-1D77 1D79-1D9A 1E00-1F15 1F18-1F1D 1F20-1F45
					1F48-1F4D 1F50-1F57 1F59 1F5B 1F5D 1F5F-1F7D 1F80-1FB4 1FB6-1FBC
					1FBE 1FC2-1FC4 1FC6-1FCC 1FD0-1FD3 1FD6-1FDB 1FE0-1FEC 1FF2-1FF4 1FF6-1FFC
					2102 2107 210A-2113 2115 2119-211D 2124 2126 2128
					212A-212D 212F-2134 2139 213C-213F 2145-2149 214E 2160-217F 2183-2184
					24B6-24E9 2C00-2C7B 2C7E-2CE4 2CEB-2CEE 2CF2-2CF3 2D00-2D25 2D27 2D2D
					A640-A66D A680-A69B A722-A76F A771-A787 A78B-A78E A790-A7DC A7F5-A7F6 A7FA
					AB30-AB5A AB60-AB68 AB70-ABBF FB00-FB06 FB13-FB17 FF21-FF3A FF41-FF5A 10400-1044F
					104B0-104D3 104D8-104FB 10570-1057A 1057C-1058A 1058C-10592 10594-10595 10597-105A1 105A3-105B1
					105B3-105B9 105BB-105BC 10C80-10CB2 10CC0-10CF2 10D50-10D65 10D70-10D85 118A0-118DF 16E40-16E7F
					16EA0-16EB8 16EBB-16ED3 1D400-1D454 1D456-1D49C 1D49E-1D49F 1D4A2 1D4A5-1D4A6 1D4A9-1D4AC
					1D4AE-1D4B9 1D4BB 1D4BD-1D4C3 1D4C5-1D505 1D507-1D50A 1D50D-1D514 1D516-1D51C 1D51E-1D539
					1D53B-1D53E 1D540-1D544 1D546 1D54A-1D550 1D552-1D6A5 1D6A8-1D6C0 1D6C2-1D6DA 1D6DC-1D6FA
					1D6FC-1D714 1D716-1D734 1D736-1D74E 1D750-1D76E 1D770-1D788 1D78A-1D7A8 1D7AA-1D7C2 1D7C4-1D7CB
					1DF00-1DF09 1DF0B-1DF1E 1DF25-1DF2A 1E900-1E943 1F130-1F149 1F150-1F169 1F170-1F189';
				lc_ignorable constant text := '
					0027 002E 003A 005E 0060 00A8 00AD 00AF
					00B4 00B7-00B8 02B0-036F 0374-0375 037A 0384-0385 0387 0483-0489
					0559 055F 0591-05BD 05BF 05C1-05C2 05C4-05C5 05C7 05F4
					0600-0605 0610-061A 061C 0640 064B-065F 0670 06D6-06DD 06DF-06E8
					06EA-06ED 070F 0711 0730-074A 07A6-07B0 07EB-07F5 07FA 07FD
					0816-082D 0859-085B 0888 0890-0891 0897-089F 08C9-0902 093A 093C
					0941-0948 094D 0951-0957 0962-0963 0971 0981 09BC 09C1-09C4
					09CD 09E2-09E3 09FE 0A01-0A02 0A3C 0A41-0A42 0A47-0A48 0A4B-0A4D
					0A51 0A70-0A71 0A75 0A81-0A82 0ABC 0AC1-0AC5 0AC7-0AC8 0ACD
					0AE2-0AE3 0AFA-0AFF 0B01 0B3C 0B3F 0B41-0B44 0B4D 0B55-0B56
					0B62-0B63 0B82 0BC0 0BCD 0C00 0C04 0C3C 0C3E-0C40
					0C46-0C48 0C4A-0C4D 0C55-0C56 0C62-0C63 0C81 0CBC 0CBF 0CC6
					0CCC-0CCD 0CE2-0CE3 0D00-0D01 0D3B-0D3C 0D41-0D44 0D4D 0D62-0D63 0D81
					0DCA 0DD2-0DD4 0DD6 0E31 0E34-0E3A 0E46-0E4E 0EB1 0EB4-0EBC
					0EC6 0EC8-0ECE 0F18-0F19 0F35 0F37 0F39 0F71-0F7E 0F80-0F84
					0F86-0F87 0F8D-0F97 0F99-0FBC 0FC6 102D-1030 1032-1037 1039-103A 103D-103E
					1058-1059 105E-1060 1071-1074 1082 1085-1086 108D 109D 10FC
					135D-135F 1712-1714 1732-1733 1752-1753 1772-1773 17B4-17B5 17B7-17BD 17C6
					17C9-17D3 17D7 17DD 180B-180F 1843 1885-1886 18A9 1920-1922
					1927-1928 1932 1939-193B 1A17-1A18 1A1B 1A56 1A58-1A5E 1A60
					1A62 1A65-1A6C 1A73-1A7C 1A7F 1AA7 1AB0-1ADD 1AE0-1AEB 1B00-1B03
					1B34 1B36-1B3A 1B3C 1B42 1B6B-1B73 1B80-1B81 1BA2-1BA5 1BA8-1BA9
					1BAB-1BAD 1BE6 1BE8-1BE9 1BED 1BEF-1BF1 1C2C-1C33 1C36-1C37 1C78-1C7D
					1CD0-1CD2 1CD4-1CE0 1CE2-1CE8 1CED 1CF4 1CF8-1CF9 1D2C-1D6A 1D78
					1D9B-1DFF 1FBD 1FBF-1FC1 1FCD-1FCF 1FDD-1FDF 1FED-1FEF 1FFD-1FFE 200B-200F
					2018-2019 2024 2027 202A-202E 2060-2064 2066-206F 2071 207F
					2090-209C 20D0-20F0 2C7C-2C7D 2CEF-2CF1 2D6F 2D7F 2DE0-2DFF 2E2F
					3005 302A-302D 3031-3035 303B 3099-309E 30FC-30FE A015 A4F8-A4FD
					A60C A66F-A672 A674-A67D A67F A69C-A69F A6F0-A6F1 A700-A721 A770
					A788-A78A A7F1-A7F4 A7F8-A7F9 A802 A806 A80B A825-A826 A82C
					A8C4-A8C5 A8E0-A8F1 A8FF A926-A92D A947-A951 A980-A982 A9B3 A9B6-A9B9
					A9BC-A9BD A9CF A9E5-A9E6 AA29-AA2E AA31-AA32 AA35-AA36 AA43 AA4C
					AA70 AA7C AAB0 AAB2-AAB4 AAB7-AAB8 AABE-AABF AAC1 AADD
					AAEC-AAED AAF3-AAF4 AAF6 AB5B-AB5F AB69-AB6B ABE5 ABE8 ABED
					FB1E FBB2-FBC2 FE00-FE0F FE13 FE20-FE2F FE52 FE55 FEFF
					FF07 FF0E FF1A FF3E FF40 FF70 FF9E-FF9F FFE3
					FFF9-FFFB 101FD 102E0 10376-1037A 10780-10785 10787-107B0 107B2-107BA 10A01-10A03
					10A05-10A06 10A0C-10A0F 10A38-10A3A 10A3F 10AE5-10AE6 10D24-10D27 10D4E 10D69-10D6D
					10D6F 10EAB-10EAC 10EC5 10EFA-10EFF 10F46-10F50 10F82-10F85 11001 11038-11046
					11070 11073-11074 1107F-11081 110B3-110B6 110B9-110BA 110BD 110C2 110CD
					11100-11102 11127-1112B 1112D-11134 11173 11180-11181 111B6-111BE 111C9-111CC 111CF
					1122F-11231 11234 11236-11237 1123E 11241 112DF 112E3-112EA 11300-11301
					1133B-1133C 11340 11366-1136C 11370-11374 113BB-113C0 113CE 113D0 113D2
					113E1-113E2 11438-1143F 11442-11444 11446 1145E 114B3-114B8 114BA 114BF-114C0
					114C2-114C3 115B2-115B5 115BC-115BD 115BF-115C0 115DC-115DD 11633-1163A 1163D 1163F-11640
					116AB 116AD 116B0-116B5 116B7 1171D 1171F 11722-11725 11727-1172B
					1182F-11837 11839-1183A 1193B-1193C 1193E 11943 119D4-119D7 119DA-119DB 119E0
					11A01-11A0A 11A33-11A38 11A3B-11A3E 11A47 11A51-11A56 11A59-11A5B 11A8A-11A96 11A98-11A99
					11B60 11B62-11B64 11B66 11C30-11C36 11C38-11C3D 11C3F 11C92-11CA7 11CAA-11CB0
					11CB2-11CB3 11CB5-11CB6 11D31-11D36 11D3A 11D3C-11D3D 11D3F-11D45 11D47 11D90-11D91
					11D95 11D97 11DD9 11EF3-11EF4 11F00-11F01 11F36-11F3A 11F40 11F42
					11F5A 13430-13440 13447-13455 1611E-16129 1612D-1612F 16AF0-16AF4 16B30-16B36 16B40-16B43
					16D40-16D42 16D6B-16D6C 16F4F 16F8F-16F9F 16FE0-16FE1 16FE3-16FE4 16FF2-16FF3 1AFF0-1AFF3
					1AFF5-1AFFB 1AFFD-1AFFE 1BC9D-1BC9E 1BCA0-1BCA3 1CF00-1CF2D 1CF30-1CF46 1D167-1D169 1D173-1D182
					1D185-1D18B 1D1AA-1D1AD 1D242-1D244 1DA00-1DA36 1DA3B-1DA6C 1DA75 1DA84 1DA9B-1DA9F
					1DAA1-1DAAF 1E000-1E006 1E008-1E018 1E01B-1E021 1E023-1E024 1E026-1E02A 1E030-1E06D 1E08F
					1E130-1E13D 1E2AE 1E2EC-1E2EF 1E4EB-1E4EF 1E5EE-1E5EF 1E6E3 1E6E6 1E6EE-1E6EF
					1E6F5 1E6FF 1E8D0-1E8D6 1E944-1E94B 1F3FB-1F3FF E0001 E0020-E007F E0100-E01EF';
				lc_from     text;
				lc_to       text;
				cased       text;
				ignorable   text;
				final_sigma text;
			BEGIN
				IF current_setting('server_encoding') <> 'UTF8' THEN
					RAISE EXCEPTION 'copying Dash Permissions grants needs a UTF8 database, not %',
						current_setting('server_encoding');
				END IF;

				SELECT string_agg(chr(cp), '' ORDER BY cp), string_agg(chr(cp + delta), '' ORDER BY cp)
				  INTO lc_from, lc_to
				  FROM (
					SELECT ('x' || lpad(r[1], 8, '0'))::bit(32)::int AS lo,
					       ('x' || lpad(r[2], 8, '0'))::bit(32)::int AS hi,
					       r[3]::int AS step,
					       r[4]::int AS delta
					  FROM regexp_matches(lc_runs, '([0-9A-F]+)-([0-9A-F]+)/([0-9]+)([+-][0-9]+)', 'g') AS r
				  ) run
				 CROSS JOIN generate_series(run.lo, run.hi, run.step) AS cp;

				SELECT '[' || string_agg('\\U' || lpad(r[1], 8, '0')
				                         || coalesce('-\\U' || lpad(r[2], 8, '0'), ''), '') || ']'
				  INTO cased
				  FROM regexp_matches(lc_cased, '([0-9A-F]+)(?:-([0-9A-F]+))?', 'g') AS r;
				SELECT '[' || string_agg('\\U' || lpad(r[1], 8, '0')
				                         || coalesce('-\\U' || lpad(r[2], 8, '0'), ''), '') || ']'
				  INTO ignorable
				  FROM regexp_matches(lc_ignorable, '([0-9A-F]+)(?:-([0-9A-F]+))?', 'g') AS r;

				-- A token the parse skipped would silently drop a mapping.
				IF length(lc_from) <> 1487 OR length(lc_to) <> 1487
				   OR (SELECT count(*) FROM regexp_matches(lc_cased, '[0-9A-F]+(-[0-9A-F]+)?', 'g')) <> 151
				   OR (SELECT count(*) FROM regexp_matches(lc_ignorable, '[0-9A-F]+(-[0-9A-F]+)?', 'g')) <> 464 THEN
					RAISE EXCEPTION 'migration 11 lowercase table failed to parse';
				END IF;

				final_sigma := '(?<=' || cased || ignorable || '*)' || chr(931)
				            || '(?!' || ignorable || '*' || cased || ')';

				SELECT count(*) INTO admins_before FROM group_admin;

				INSERT INTO group_admin (group_id, ident_subject, email)
				SELECT DISTINCT m.group_id, 'email:' || addr.lowered, addr.lowered
				  FROM member m
				  JOIN "group" g ON g.id = m.group_id
				 CROSS JOIN LATERAL (
					SELECT translate(replace(regexp_replace(m.email::text, final_sigma, chr(962), 'g'),
							chr(304), 'i' || chr(775)), lc_from, lc_to) AS lowered
				 ) addr
				 CROSS JOIN LATERAL (
					SELECT CASE
						WHEN s.spec IS NULL OR s.spec = 'null' OR s.spec = 'false'
						  OR s.spec = '0' OR s.spec = '""'
							THEN '["Dash Permissions"]'::jsonb
						WHEN jsonb_typeof(s.spec) = 'string'
							THEN jsonb_build_array(s.spec)
						WHEN jsonb_typeof(s.spec) = 'array'
						 AND NOT jsonb_path_exists(s.spec, '$[*] ? (@.type() != "string")')
							THEN s.spec
					END AS wanted
					  FROM (SELECT g.column_map -> 'dashPermissions' AS spec) s
				 ) w
				 CROSS JOIN LATERAL (
					SELECT m.data -> k.key AS cell
					  FROM jsonb_array_elements_text(w.wanted) WITH ORDINALITY AS h(header, hord)
					 CROSS JOIN LATERAL (
						SELECT translate(replace(regexp_replace(btrim(regexp_replace(h.header, '[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]' || '+', ' ', 'g'), ' '), final_sigma, chr(962), 'g'),
							chr(304), 'i' || chr(775)), lc_from, lc_to) AS norm
					 ) hn
					  JOIN jsonb_object_keys(
							CASE jsonb_typeof(m.data) WHEN 'object' THEN m.data ELSE '{}'::jsonb END
						) WITH ORDINALITY AS k(key, kord)
					    ON translate(replace(regexp_replace(btrim(regexp_replace(k.key, '[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]' || '+', ' ', 'g'), ' '), final_sigma, chr(962), 'g'),
							chr(304), 'i' || chr(775)), lc_from, lc_to) = hn.norm
					 ORDER BY h.hord, k.kord DESC
					 LIMIT 1
				 ) perm
				 WHERE m.status = 'active'
				   AND EXISTS (
					WITH RECURSIVE leaf(j) AS (
						SELECT perm.cell
						 UNION ALL
						SELECT e FROM leaf, jsonb_array_elements(
							CASE jsonb_typeof(leaf.j) WHEN 'array' THEN leaf.j ELSE '[]'::jsonb END
						) AS e
					)
					SELECT 1
					  FROM leaf, regexp_split_to_table(leaf.j #>> '{}', '[,;]') AS part
					 WHERE jsonb_typeof(leaf.j) = 'string'
					   AND translate(replace(regexp_replace(regexp_replace(part, '^' || '[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]' || '+|' || '[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]' || '+$', '', 'g'), final_sigma, chr(962), 'g'),
							chr(304), 'i' || chr(775)), lc_from, lc_to)
					       IN ('admin', 'owner', 'superadmin')
				   )
				ON CONFLICT (group_id, ident_subject) DO NOTHING;

				SELECT count(*) INTO admins_after FROM group_admin;
				IF admins_after < admins_before THEN
					RAISE EXCEPTION 'group_admin shrank from % to % while copying Dash Permissions grants',
						admins_before, admins_after;
				END IF;
			END
			$$;
		`
	},
	{
		version: 12,
		name: 'access_request_native',
		sql: /* sql */ `
			-- Membership requests live here rather than in a "Requests" sheet tab.
			-- data is keyed exactly as member.data is, by sheet header text, so
			-- approval copies it into a member row instead of matching headers.
			--
			-- A denied or approved row is kept. The partial unique index from
			-- migration 1 covers pending rows only, so a resubmission after a denial
			-- inserts a fresh pending row beside the denied one, and the admin card
			-- can show that this person was turned down before. Resubmission is not
			-- blocked here on purpose: a schema-level refusal would be a lockout with
			-- no appeal path.
			--
			-- sheet_appended_at marked a row copied into the sheet. Nothing copies
			-- to the sheet any more.
			ALTER TABLE access_request
				ADD COLUMN IF NOT EXISTS data        jsonb NOT NULL DEFAULT '{}'::jsonb,
				ADD COLUMN IF NOT EXISTS decided_by  text,
				ADD COLUMN IF NOT EXISTS deny_reason text,
				ADD COLUMN IF NOT EXISTS updated_at  timestamptz NOT NULL DEFAULT now(),
				DROP COLUMN IF EXISTS sheet_appended_at;
			ALTER TABLE access_request
				ADD CONSTRAINT access_request_status_check
				CHECK (status IN ('pending', 'approved', 'denied'));
		`
	},
	{
		version: 13,
		name: 'member_data_stable_keys',
		sql: /* sql */ `
			-- member.data was keyed by the Google Sheet's header text until this
			-- migration renamed every key to the field schema's stable key and moved
			-- the private ones into member.private_data, which search never reads.
			--
			-- The header-to-key table that did the renaming has left core: only one
			-- database ever held Sheet-keyed rows, and it is converted by a build
			-- from before the table was removed. What remains is the schema change
			-- every later migration and reader expects. A database whose member or
			-- request rows still hold data refuses here, before any statement below
			-- touches a table: renaming those keys by anything but the frozen table
			-- would file values under keys nobody reviewed, private ones included.
			-- A fresh database holds no such rows and applies the schema alone.
			DO $$
			DECLARE
				n_members  bigint;
				n_requests bigint;
			BEGIN
				SELECT count(*) INTO n_members FROM member WHERE data <> '{}'::jsonb;
				SELECT count(*) INTO n_requests FROM access_request WHERE data <> '{}'::jsonb;
				IF n_members > 0 OR n_requests > 0 THEN
					RAISE EXCEPTION 'migration 13: % member row(s) and % membership request(s) still hold data keyed by the retired Google Sheet headers, and this build no longer carries the table that converts them. Migrate this database first with a build from before that table left core (76356d2 or earlier), then start this build. Nothing was changed.', n_members, n_requests;
				END IF;
			END
			$$;

			ALTER TABLE member
				ADD COLUMN IF NOT EXISTS private_data jsonb NOT NULL DEFAULT '{}'::jsonb;

			-- search_tsv reads data alone, which now holds no private field, so the
			-- key deny-list migration 6 needed is gone. Checkbox values are still left
			-- out: "TRUE" on every row would match every member.
			ALTER TABLE member DROP COLUMN IF EXISTS search_tsv;
			CREATE OR REPLACE FUNCTION member_search_values(d jsonb) RETURNS text
				LANGUAGE sql IMMUTABLE AS $$
					SELECT coalesce(string_agg(value, ' '), '')
					FROM jsonb_each_text(d)
					WHERE lower(btrim(value)) NOT IN
					      ('true', 'false', 'yes', 'no', 'y', 'n', 'x', '1', '0', 'checked', 'on')
				$$;
			ALTER TABLE member ADD COLUMN search_tsv tsvector
				GENERATED ALWAYS AS (
					to_tsvector('simple',
						coalesce(name, '') || ' ' || coalesce(city, '') || ' ' ||
						coalesce(linkedin, '') || ' ' || member_search_values(data))
				) STORED;
			CREATE INDEX IF NOT EXISTS member_search_tsv_idx
				ON member USING gin (search_tsv);
		`
	},
	{
		// A roster import's preview, held until the admin who read it applies it.
		// It carries the parsed file, private columns included, so it lives at
		// most an hour (member-import.ts deletes expired rows on every preview)
		// and is deleted as soon as it is applied.
		version: 14,
		name: 'member_import_plan',
		sql: /* sql */ `
			CREATE TABLE IF NOT EXISTS member_import_plan (
				id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				group_id   uuid NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
				created_by text NOT NULL,
				mode       text NOT NULL CHECK (mode IN ('merge', 'replace')),
				keys       jsonb NOT NULL,
				rows       jsonb NOT NULL,
				digest     text NOT NULL,
				created_at timestamptz NOT NULL DEFAULT now()
			);
			CREATE INDEX IF NOT EXISTS member_import_plan_created_idx
				ON member_import_plan(created_at);
		`
	},
	{
		version: 15,
		name: 'drop_sheet_era',
		sql: /* sql */ `
			-- What the Google Sheet integration stored and nothing reads now: where
			-- a group's sheet lived and how its headers mapped, the sync ledger,
			-- and each member's row number and last-sync time.
			--
			-- member.visibility is not part of that. It has had no reader since
			-- migration 1 and goes because it is dead.
			--
			-- An app instance older than this migration selects sheet_id and
			-- source_row by name and answers 500 once this commits, so the version
			-- is in WRITER_CUTOVER_VERSIONS and runs only with the app stopped.
			ALTER TABLE "group"
				DROP COLUMN IF EXISTS sheet_id,
				DROP COLUMN IF EXISTS sheet_range,
				DROP COLUMN IF EXISTS column_map;

			DROP TABLE IF EXISTS sync_run;

			ALTER TABLE member
				DROP COLUMN IF EXISTS source_row,
				DROP COLUMN IF EXISTS synced_at,
				DROP COLUMN IF EXISTS visibility;
		`
	},
	{
		version: 16,
		name: 'drop_group_documents',
		sql: /* sql */ `
			-- The Manifesto and Code of Conduct are the skin's copy/manifesto.md and
			-- copy/code-of-conduct.md, edited by pull request. These two columns
			-- were filled only by the Google Doc loader, which is gone.
			--
			-- Dropping a column that holds text would lose a document with no
			-- error, so the migration refuses when either holds anything for any
			-- group. Move the text into the skin, set the column to NULL, and
			-- deploy again.
			DO $$
			DECLARE
				holders text;
			BEGIN
				SELECT string_agg(slug, ', ' ORDER BY slug) INTO holders FROM "group"
				 WHERE coalesce(btrim(manifesto_md), '') <> ''
				    OR coalesce(btrim(code_of_conduct_md), '') <> '';
				IF holders IS NOT NULL THEN
					RAISE EXCEPTION 'migration 16: group.manifesto_md or group.code_of_conduct_md holds text for %; move it to the skin''s copy directory and set both to NULL first. Nothing was applied.', holders;
				END IF;
			END
			$$;

			ALTER TABLE "group"
				DROP COLUMN IF EXISTS manifesto_md,
				DROP COLUMN IF EXISTS code_of_conduct_md;
		`
	},
	{
		// Search folds accents on both sides. The stock unaccent() is STABLE,
		// because it looks its dictionary up through search_path at call time,
		// so it cannot back an index. Naming the dictionary by schema removes
		// that lookup, which is what makes declaring the wrapper IMMUTABLE
		// truthful. The schema is read from the catalog rather than assumed,
		// since IF NOT EXISTS keeps wherever an earlier install put it.
		version: 17,
		name: 'search_unaccent',
		sql: /* sql */ `
			CREATE EXTENSION IF NOT EXISTS unaccent;

			DO $do$
			DECLARE
				s text;
			BEGIN
				SELECT n.nspname INTO s
				  FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
				 WHERE e.extname = 'unaccent';
				EXECUTE format(
					$f$CREATE OR REPLACE FUNCTION search_unaccent(text) RETURNS text
					   LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
					   AS $body$ SELECT %1$I.unaccent(%2$L::regdictionary, $1) $body$ $f$,
					s,
					quote_ident(s) || '.unaccent'
				);
			END
			$do$;
		`
	},
	{
		// Keyed by member, not by address: an email change rewrites the member
		// row and never this table. `id` is the raw credential id the
		// authenticator returns, so a sign-in finds its row without knowing who
		// is signing in.
		version: 18,
		name: 'passkey_credential',
		sql: /* sql */ `
			CREATE TABLE IF NOT EXISTS passkey_credential (
				id           bytea PRIMARY KEY,
				member_id    uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
				public_key   bytea NOT NULL,
				sign_count   bigint NOT NULL DEFAULT 0,
				transports   text[] NOT NULL DEFAULT '{}',
				backed_up    bool NOT NULL DEFAULT false,
				device_type  text NOT NULL,
				nickname     text NOT NULL,
				created_at   timestamptz NOT NULL DEFAULT now(),
				last_used_at timestamptz
			);
			CREATE INDEX IF NOT EXISTS passkey_credential_member_idx
				ON passkey_credential(member_id);
		`
	},
	{
		// A member's chosen profile URL. citext, so the index refuses a second
		// member claiming the same name in another case. A name given up stays
		// with its owner in member_username_retired, so an old link keeps
		// resolving and nobody else can take it over; the two tables are kept
		// apart by the write path under the group's member-write lock, since no
		// index spans both.
		version: 19,
		name: 'member_username',
		sql: /* sql */ `
			ALTER TABLE member ADD COLUMN IF NOT EXISTS username citext;
			CREATE UNIQUE INDEX IF NOT EXISTS member_group_username_key
				ON member(group_id, username);
			CREATE TABLE IF NOT EXISTS member_username_retired (
				group_id   uuid NOT NULL REFERENCES "group"(id) ON DELETE CASCADE,
				username   citext NOT NULL,
				member_id  uuid NOT NULL REFERENCES member(id) ON DELETE CASCADE,
				retired_at timestamptz NOT NULL DEFAULT now(),
				PRIMARY KEY (group_id, username)
			);
			CREATE INDEX IF NOT EXISTS member_username_retired_member_idx
				ON member_username_retired(member_id);
		`
	},
	{
		// What makes an emailed sign-in address change or its undo link still
		// valid when it is clicked. An address names whoever holds it at that
		// moment, so a link that carried only addresses could move a different
		// account that took over a freed one.
		//
		// identity_epoch is set from one sequence on every row of an identity
		// each time its address moves. A change link carries the member id and
		// epoch it was requested under, and stops working once anything moves
		// the identity again: the change it was racing, an undo, an operator.
		//
		// An undo link is a row here, because undoing has to cancel the undo
		// links issued after the change it reverses (a hijacker's second change
		// mails one to the hijacker) while keeping the earlier ones, which go to
		// addresses the owner held. An epoch alone cannot say "later than mine".
		version: 20,
		name: 'email_change_binding',
		sql: /* sql */ `
			ALTER TABLE member ADD COLUMN IF NOT EXISTS identity_epoch bigint NOT NULL DEFAULT 0;
			CREATE SEQUENCE IF NOT EXISTS member_identity_epoch_seq;

			CREATE TABLE IF NOT EXISTS email_revert_grant (
				id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				member_ids  uuid[] NOT NULL,
				restore_to  citext NOT NULL,
				epoch       bigint NOT NULL,
				expires_at  timestamptz NOT NULL,
				spent_at    timestamptz
			);
			CREATE INDEX IF NOT EXISTS email_revert_grant_members_idx
				ON email_revert_grant USING gin (member_ids);
		`
	},
	{
		// An address may name one account across every group, but the schema
		// can only say so within a group. So every write that puts an address
		// on a member or admin row takes a shared transaction lock, and an
		// address move takes the same lock exclusively before it checks the
		// destination (lockMembersIn). The move then sees every claim that
		// committed, and none can start until it commits. Triggers rather than
		// calls in each writer, so the import, approvals, admin grants and the
		// operator script cannot skip it. Writers take it after their group
		// lock, as the move does, which keeps the two deadlock-free.
		//
		// A member row inserted at an address that an account with a live undo
		// link holds joins that link, so the undo still reaches the membership
		// once the rows the link was issued for are gone.
		version: 21,
		name: 'identity_claim_lock',
		sql: /* sql */ `
			CREATE OR REPLACE FUNCTION identity_claim_lock() RETURNS trigger
			LANGUAGE plpgsql AS $$
			BEGIN
				PERFORM pg_advisory_xact_lock_shared(hashtextextended('identity-claim', 0));
				RETURN NEW;
			END $$;

			DROP TRIGGER IF EXISTS member_identity_claim ON member;
			CREATE TRIGGER member_identity_claim
				BEFORE INSERT OR UPDATE OF email ON member
				FOR EACH ROW EXECUTE FUNCTION identity_claim_lock();
			DROP TRIGGER IF EXISTS group_admin_identity_claim ON group_admin;
			CREATE TRIGGER group_admin_identity_claim
				BEFORE INSERT OR UPDATE OF ident_subject, email ON group_admin
				FOR EACH ROW EXECUTE FUNCTION identity_claim_lock();

			CREATE OR REPLACE FUNCTION member_joins_revert_grants() RETURNS trigger
			LANGUAGE plpgsql AS $$
			BEGIN
				IF NOT EXISTS (SELECT 1 FROM email_revert_grant
				                WHERE spent_at IS NULL AND expires_at > now()) THEN
					RETURN NULL;
				END IF;
				UPDATE email_revert_grant
				   SET member_ids = array_append(member_ids, NEW.id)
				 WHERE spent_at IS NULL AND expires_at > now()
				   AND NOT (NEW.id = ANY(member_ids))
				   AND member_ids && ARRAY(
				         SELECT id FROM member WHERE email = NEW.email AND id <> NEW.id);
				RETURN NULL;
			END $$;

			DROP TRIGGER IF EXISTS member_joins_revert_grants ON member;
			CREATE TRIGGER member_joins_revert_grants
				AFTER INSERT ON member
				FOR EACH ROW EXECUTE FUNCTION member_joins_revert_grants();
		`
	},
	{
		// A member's links to other sites are a list of {site, handle} in the
		// profile data (src/lib/links.ts). The one link the member row carried
		// as a column, LinkedIn, moves into that list first (`run`), then the
		// column goes. Search reads a links list as its handles alone, so a
		// word like "site" matches nobody. The generated column cannot see the
		// skin, so a links list is recognized by its form: a non-empty array of
		// objects holding exactly a string `site` and `handle`. Any other value,
		// arrays included, is searched as its JSON text, as before.
		version: 22,
		name: 'profile_links',
		run: (client) => convertLinkedin(client),
		sql: /* sql */ `
			ALTER TABLE member DROP COLUMN IF EXISTS search_tsv;
			ALTER TABLE member DROP COLUMN IF EXISTS linkedin;
			CREATE OR REPLACE FUNCTION member_is_links(v jsonb) RETURNS boolean
				LANGUAGE sql IMMUTABLE AS $$
					SELECT coalesce(jsonb_typeof(v) = 'array', false)
					   AND jsonb_array_length(v) > 0
					   AND NOT EXISTS (
					       SELECT 1 FROM jsonb_array_elements(v) AS e
					        WHERE NOT coalesce(
					                  jsonb_typeof(e) = 'object'
					                  AND (e - 'site' - 'handle') = '{}'::jsonb
					                  AND jsonb_typeof(e->'site') = 'string'
					                  AND jsonb_typeof(e->'handle') = 'string',
					              false))
				$$;
			CREATE OR REPLACE FUNCTION member_value_text(v jsonb) RETURNS text
				LANGUAGE sql IMMUTABLE AS $$
					SELECT CASE WHEN member_is_links(v) THEN (
						SELECT string_agg(e->>'handle', ' ') FROM jsonb_array_elements(v) AS e
					) ELSE coalesce(v #>> '{}', '') END
				$$;
			CREATE OR REPLACE FUNCTION member_search_values(d jsonb) RETURNS text
				LANGUAGE sql IMMUTABLE AS $$
					SELECT coalesce(string_agg(t, ' '), '')
					FROM (SELECT member_value_text(value) AS t FROM jsonb_each(d)) AS x
					WHERE lower(btrim(t)) NOT IN
					      ('true', 'false', 'yes', 'no', 'y', 'n', 'x', '1', '0', 'checked', 'on')
				$$;
			ALTER TABLE member ADD COLUMN search_tsv tsvector
				GENERATED ALWAYS AS (
					to_tsvector('simple',
						coalesce(name, '') || ' ' || coalesce(city, '') || ' ' ||
						member_search_values(data))
				) STORED;
			CREATE INDEX IF NOT EXISTS member_search_tsv_idx
				ON member USING gin (search_tsv);
		`
	}
];

// Migrations an already-running app does not survive, so they run only with
// every app instance stopped. Locking the tables inside the transaction would
// not help: the damage happens after the commit, not during it.
//
// 13 re-keys member data: an older instance reads keys that no longer exist
// and writes sheet-header keys back into the searchable `data` bag, private
// fields included.
//
// 15 and 16 drop columns an older instance selects by name, so every group
// page it serves is a 500. The deploy migrates before it builds the
// replacement, and a failed build would leave that instance serving the dropped
// schema until somebody noticed.
//
// 22 drops member.linkedin, which an older instance selects by name, and
// rewrites the LinkedIn values an older instance would write back as columns.
export const WRITER_CUTOVER_VERSIONS: ReadonlySet<number> = new Set([13, 15, 16, 22]);

// Why the gating runner must not apply a pending cutover migration yet, or null
// when it may. Two conditions, because neither is enough alone: the operator
// names the database whose writers they stopped (an idle app pool holds no
// connection, so pg_stat_activity cannot prove absence), and no other client
// is connected to that database right now (which catches the name typed
// before the stop). A database with no ledger yet has never served an app.
export async function writerCutoverRefusal(
	client: pg.ClientBase,
	stoppedFor: string | undefined
): Promise<string | null> {
	const {
		rows: [{ ledger }]
	} = await client.query<{ ledger: string | null }>(
		`SELECT to_regclass('schema_migrations')::text AS ledger`
	);
	if (!ledger) return null;
	const { rows } = await client.query<{ version: number }>('SELECT version FROM schema_migrations');
	const done = new Set(rows.map((r) => r.version));
	const pending = [...WRITER_CUTOVER_VERSIONS].filter((v) => !done.has(v));
	if (pending.length === 0) return null;
	const {
		rows: [{ db }]
	} = await client.query<{ db: string }>('SELECT current_database() AS db');
	if (stoppedFor !== db) {
		return (
			`migration ${pending.join(', ')} changes what a running app reads and needs every app ` +
			`instance stopped first. Build the new image, stop the app, then run again with ` +
			`LOREM_WRITERS_STOPPED=${db} (docs/deployment.md, Migrations). ` +
			`Nothing was applied.`
		);
	}
	const { rows: others } = await client.query<{ who: string }>(
		`SELECT coalesce(nullif(application_name, ''), 'unnamed') || '@' ||
		        coalesce(host(client_addr), 'local') AS who
		   FROM pg_stat_activity
		  WHERE datname = current_database()
		    AND pid <> pg_backend_pid()
		    AND backend_type = 'client backend'`
	);
	if (others.length > 0) {
		return (
			`migration ${pending.join(', ')} needs every writer stopped, but ${others.length} ` +
			`other connection(s) to ${db} are open (${others.map((o) => o.who).join(', ')}). ` +
			`Stop the app and retry. Nothing was applied.`
		);
	}
	return null;
}

// The gate and the run together, for every script an operator can start beside
// a serving app. Boot (`ensureSchema`) calls `migrate` directly: the instance
// booting is the replacement, so the one it replaced has already stopped.
export async function migrateGated(
	pool: pg.Pool,
	stoppedFor: string | undefined,
	note?: (line: string) => void
): Promise<number[]> {
	const client = await pool.connect();
	try {
		const refusal = await writerCutoverRefusal(client, stoppedFor);
		if (refusal) throw new Error(refusal);
	} finally {
		client.release();
	}
	return migrate(pool, note);
}

// Apply any unapplied migrations in order. Idempotent. Takes a Pool so it
// can grab a single dedicated client for the (session-scoped) advisory lock
// + transaction. Returns the list of versions actually applied this run.
export async function migrate(
	pool: pg.Pool,
	note: (line: string) => void = () => {}
): Promise<number[]> {
	const client = await pool.connect();
	const applied: number[] = [];
	try {
		await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
		try {
			await client.query('BEGIN');
			await client.query(`
				CREATE TABLE IF NOT EXISTS schema_migrations (
					version    int PRIMARY KEY,
					name       text NOT NULL,
					applied_at timestamptz NOT NULL DEFAULT now()
				)
			`);
			const { rows } = await client.query<{ version: number }>(
				'SELECT version FROM schema_migrations'
			);
			const done = new Set(rows.map((r) => r.version));
			const pending = MIGRATIONS.filter((m) => !done.has(m.version)).sort(
				(a, b) => a.version - b.version
			);
			for (const m of pending) {
				if (m.run) note(await m.run(client));
				await client.query(m.sql);
				await client.query('INSERT INTO schema_migrations(version, name) VALUES ($1, $2)', [
					m.version,
					m.name
				]);
				applied.push(m.version);
			}
			await client.query('COMMIT');
		} catch (e) {
			await client.query('ROLLBACK').catch(() => {});
			throw e;
		} finally {
			await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
		}
		return applied;
	} finally {
		client.release();
	}
}
