// Self-hosted profile photos (member_avatar table). Rows are keyed by
// md5(lowercased email) — an email owns its avatar, matching how logins key on
// email rather than on a group/member row.
//
// That hash is a *storage* key and stays server-side. Photos are served at
// /avatar/<public id>, a random uuid per row: the endpoint is unauthenticated,
// and while its URL was md5(email) anyone could hash a guessed address and read
// membership off the response. It is md5 rather than the sha256 Gravatar now
// specifies because the two are unrelated jobs that happened to share an
// algorithm: this one addresses a row in our table, and re-keying it would
// rewrite every primary key to gain nothing.
//
// A row holds one of three things, in `source`:
//
//   upload    bytes the member gave us. Outranks everything; no refresh touches
//             it, because a member who uploaded a photo has already said which
//             picture they want.
//   gravatar  bytes fetched from Gravatar on the app's behalf, refreshed past
//             the TTL. The member's browser never talks to Automattic.
//   none      Gravatar answered 404. Carries no bytes and exists only so the
//             next render does not ask again — most members have no Gravatar,
//             so this row is the difference between ten calls a week and
//             thousands.

import { query } from '$lib/server/postgres';
import { md5 } from '$lib/md5';
import type { Queryable } from '$lib/server/audit-core';

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024; // 2 MB

export function emailMd5(email: string): string {
	return md5(email.trim().toLowerCase());
}

export type AvatarSource = 'upload' | 'gravatar' | 'none';

export type AvatarRow = {
	/** Null on a `none` row: the negative cache carries no image. */
	bytes: Uint8Array | null;
	contentType: string | null;
	updatedAt: Date;
	source: AvatarSource;
	email: string;
	/** When Gravatar was last asked, not when the bytes last changed. */
	fetchedAt: Date | null;
	/** Gravatar's Last-Modified, echoed back to make a refresh conditional. */
	lastModified: string | null;
};

export async function getAvatarByPublicId(publicId: string): Promise<AvatarRow | null> {
	// pg returns bytea as a Buffer (a Uint8Array subclass) — typed as Uint8Array
	// so it's a valid Response BodyInit without a copy.
	const { rows } = await query<{
		bytes: Uint8Array | null;
		content_type: string | null;
		updated_at: Date;
		source: AvatarSource;
		email: string;
		fetched_at: Date | null;
		last_modified: string | null;
	}>(
		`SELECT bytes, content_type, updated_at, source, email, fetched_at, last_modified
		   FROM member_avatar WHERE public_id = $1`,
		[publicId]
	);
	const r = rows[0];
	if (!r) return null;
	return {
		bytes: r.bytes,
		contentType: r.content_type,
		updatedAt: r.updated_at,
		source: r.source,
		email: r.email,
		fetchedAt: r.fetched_at,
		lastModified: r.last_modified
	};
}

/**
 * Make sure every address has a row, so each one has a `public_id` to be
 * addressed by before anybody knows whether a photo exists.
 *
 * The uuid is the whole reason this runs. A page needs a URL for each member's
 * avatar, that URL must not be derived from the address, and the only
 * address-free handle in this design is the row's `public_id`. Creating the row
 * up front is what lets the image endpoint do the Gravatar lookup lazily, on a
 * real request for a real member, instead of a sweep over the roster.
 *
 * `source = 'none'` with `fetched_at = NULL` is the correct starting state: no
 * image, and never asked. The endpoint reads that as "cold", not as "checked
 * and absent", so a new row is fetched on first sight.
 */
export async function ensureAvatarRows(emails: string[]): Promise<Map<string, string>> {
	const seen = new Map<string, string>(); // normalized email → md5
	for (const raw of emails) {
		const e = (raw ?? '').trim().toLowerCase();
		if (e) seen.set(e, emailMd5(e));
	}
	if (!seen.size) return new Map();

	const list = [...seen.entries()];
	// One statement rather than one per address: this runs on a page load, and a
	// round trip per member would cost more than the images do.
	await query(
		`INSERT INTO member_avatar (email_md5, email, source)
		 SELECT * FROM unnest($1::text[], $2::citext[], $3::text[])
		 ON CONFLICT (email_md5) DO NOTHING`,
		[list.map(([, h]) => h), list.map(([e]) => e), list.map(() => 'none')]
	);

	const { rows } = await query<{ email_md5: string; public_id: string }>(
		'SELECT email_md5, public_id FROM member_avatar WHERE email_md5 = ANY($1::text[])',
		[list.map(([, h]) => h)]
	);
	return new Map(rows.map((r) => [r.email_md5, r.public_id]));
}

/**
 * Record what Gravatar said. Never touches an upload.
 *
 * Takes the address and derives the storage key here rather than accepting a
 * pre-computed one, so md5-as-storage-key stays a fact about this module. The
 * caller deals in addresses and sha256; nothing outside this file should have
 * to know the table is keyed the other way.
 */
export async function recordGravatar(
	email: string,
	result:
		| { outcome: 'image'; bytes: Buffer; contentType: string; lastModified: string | null }
		| { outcome: 'none' }
		| { outcome: 'unchanged' }
): Promise<void> {
	const key = emailMd5(email);
	// `source <> 'upload'` in every branch is the guard that makes an upload
	// final. Without it a refresh landing between an upload and the next render
	// would replace the member's own photo with whatever Gravatar holds.
	if (result.outcome === 'image') {
		await query(
			`UPDATE member_avatar
			    SET bytes = $2, content_type = $3, last_modified = $4,
			        source = 'gravatar', fetched_at = now(), updated_at = now()
			  WHERE email_md5 = $1 AND source <> 'upload'`,
			[key, result.bytes, result.contentType, result.lastModified]
		);
		return;
	}
	if (result.outcome === 'none') {
		await query(
			`UPDATE member_avatar
			    SET bytes = NULL, content_type = NULL, last_modified = NULL,
			        source = 'none', fetched_at = now(), updated_at = now()
			  WHERE email_md5 = $1 AND source <> 'upload'`,
			[key]
		);
		return;
	}
	// Unchanged: freshness advances, bytes do not. updated_at deliberately stays
	// put — it is the browser ETag, and moving it would re-download an image
	// Gravatar just told us is identical.
	await query(
		`UPDATE member_avatar SET fetched_at = now() WHERE email_md5 = $1 AND source <> 'upload'`,
		[key]
	);
}

/** The photo URL id for one address, or null when there's no uploaded photo. */
export async function avatarIdFor(email: string): Promise<string | null> {
	const { rows } = await query<{ public_id: string }>(
		'SELECT public_id FROM member_avatar WHERE email_md5 = $1',
		[emailMd5(email)]
	);
	return rows[0]?.public_id ?? null;
}

export async function putAvatar(
	email: string,
	bytes: Buffer,
	contentType: string
): Promise<string> {
	// public_id is untouched on conflict: replacing a photo keeps the URL already
	// mirrored into the sheet and rendered in any open page.
	const { rows } = await query<{ public_id: string }>(
		`INSERT INTO member_avatar (email_md5, email, bytes, content_type, updated_at, source)
		 VALUES ($1, $2, $3, $4, now(), 'upload')
		 ON CONFLICT (email_md5) DO UPDATE
		   SET bytes = EXCLUDED.bytes, content_type = EXCLUDED.content_type,
		       email = EXCLUDED.email, updated_at = now(),
		       source = 'upload', fetched_at = NULL, last_modified = NULL
		 RETURNING public_id`,
		[emailMd5(email), email.trim().toLowerCase(), bytes, contentType]
	);
	return rows[0].public_id;
}

// `db` lets a caller already holding a pooled connection delete on it rather
// than borrow a second one: a transaction that waits on the pool for a
// connection while holding one deadlocks once enough of them overlap.
export async function deleteAvatar(email: string, db: Queryable = { query }): Promise<void> {
	await db.query('DELETE FROM member_avatar WHERE email_md5 = $1', [emailMd5(email)]);
}

// Photo URL ids for every stored avatar, keyed by the table's md5 storage key
// (small table). Lets a directory page resolve a screenful of avatar URLs in one
// round trip, and tell the client which members have no photo at all so it skips
// straight to Gravatar for them.
export async function avatarIdsByEmailMd5(): Promise<Map<string, string>> {
	const { rows } = await query<{ email_md5: string; public_id: string }>(
		'SELECT email_md5, public_id FROM member_avatar'
	);
	return new Map(rows.map((r) => [r.email_md5, r.public_id]));
}

/**
 * One row by address, or null when the address has never been seen.
 *
 * Deliberately does not create. The sign-in refresh is its only caller, and a
 * stranger who completes a magic link is not somebody this app should mint a
 * Gravatar lookup for: they have no member row and nothing renders their photo.
 * Refreshing an existing row is the whole job.
 */
export async function getAvatarByEmail(email: string): Promise<AvatarRow | null> {
	const { rows } = await query<{
		bytes: Uint8Array | null;
		content_type: string | null;
		updated_at: Date;
		source: AvatarSource;
		email: string;
		fetched_at: Date | null;
		last_modified: string | null;
	}>(
		`SELECT bytes, content_type, updated_at, source, email, fetched_at, last_modified
		   FROM member_avatar WHERE email_md5 = $1`,
		[emailMd5(email)]
	);
	const r = rows[0];
	if (!r) return null;
	return {
		bytes: r.bytes,
		contentType: r.content_type,
		updatedAt: r.updated_at,
		source: r.source,
		email: r.email,
		fetchedAt: r.fetched_at,
		lastModified: r.last_modified
	};
}

/** The URL id for one address, creating the row if this is the first sighting. */
export async function avatarIdForOrCreate(email: string): Promise<string | null> {
	return (await ensureAvatarRows([email])).get(emailMd5(email)) ?? null;
}
