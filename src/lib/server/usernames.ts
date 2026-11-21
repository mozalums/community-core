// A member's optional username: the rule that decides what one may be, what
// the availability check reports, and the one write that changes it.
//
// The uuid stays every member's id and default URL. A username is chosen by the
// member, never derived from a name or the skin's handle field, and a name given
// up is kept in member_username_retired against its owner: links to it redirect,
// nobody else can claim it, and only the owner (by taking it back) or an admin
// (by releasing it) frees it.

import { query } from '$lib/server/postgres';
import { auditIn } from '$lib/server/audit-core';
import {
	GROUP_LOCK_SQL,
	type Actor,
	type Client,
	type GroupRef
} from '$lib/server/member-write-core';

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 30;

// The edit form posts the username under this name. A field key is camelCase
// letters and digits (src/lib/skin/schema.ts), so no skin field can spell it.
export const USERNAME_CONTROL = 'profile_username';

const UUID_LIKE = /^(?:[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})$/i;
const PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// Every child segment of src/routes/group/[slug]/members/ (a static route there
// would shadow the profile of whoever took its name; usernames.test.ts reads the
// directory and fails on a segment missing here), plus names a reader would take
// for a page rather than a person.
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
	'usernames',
	'me',
	'new',
	'admin',
	'api',
	'login',
	'logout'
]);

export type UsernameRule = 'ascii' | 'uuid' | 'length' | 'pattern' | 'digits';

const RULE_TEXT: Record<UsernameRule, string> = {
	ascii:
		'use plain letters a-z, digits and hyphens; accented and look-alike characters are refused',
	uuid: 'a username cannot look like a member id',
	length: `use ${USERNAME_MIN} to ${USERNAME_MAX} characters`,
	pattern: 'use letters, digits and single hyphens between them, with no hyphen at either end',
	digits: 'include at least one letter'
};

export type UsernameVerdict =
	| { ok: true; name: string }
	| { ok: false; status: 'invalid'; rule: UsernameRule; message: string }
	| { ok: false; status: 'reserved'; message: string };

// The one rule, for the availability endpoint and the save action alike. ASCII
// is checked before lowercasing: a URL holding a look-alike letter would point
// somewhere other than the name it reads as, and folding it to its ASCII twin
// would make two spellings one member.
export function checkUsername(raw: string): UsernameVerdict {
	const typed = raw.trim();
	const invalid = (rule: UsernameRule): UsernameVerdict => ({
		ok: false,
		status: 'invalid',
		rule,
		message: RULE_TEXT[rule]
	});
	// eslint-disable-next-line no-control-regex
	if (/[^\x00-\x7f]/.test(typed)) return invalid('ascii');
	const name = typed.toLowerCase();
	if (UUID_LIKE.test(name)) return invalid('uuid');
	if (name.length < USERNAME_MIN || name.length > USERNAME_MAX) return invalid('length');
	if (!PATTERN.test(name)) return invalid('pattern');
	if (/^[0-9]+$/.test(name)) return invalid('digits');
	if (RESERVED_USERNAMES.has(name)) {
		return { ok: false, status: 'reserved', message: 'that name is reserved for the site' };
	}
	return { ok: true, name };
}

export type UsernameStatus =
	| { status: 'available'; name: string }
	| { status: 'yours'; name: string }
	| { status: 'taken'; name: string }
	| { status: 'invalid'; rule: UsernameRule; message: string }
	| { status: 'reserved'; message: string };

// What the edit page shows as the member types. Advisory only: the save action
// runs the rule again and the unique index has the last word.
export async function usernameStatus(
	groupId: string,
	memberId: string | null,
	raw: string
): Promise<UsernameStatus> {
	const v = checkUsername(raw);
	if (!v.ok) {
		return v.status === 'invalid'
			? { status: 'invalid', rule: v.rule, message: v.message }
			: { status: 'reserved', message: v.message };
	}
	const { rows } = await query<{ owner: string; current: boolean }>(
		`SELECT id::text AS owner, true AS current FROM member
		  WHERE group_id = $1 AND username = $2
		 UNION ALL
		 SELECT member_id::text, false FROM member_username_retired
		  WHERE group_id = $1 AND username = $2`,
		[groupId, v.name]
	);
	const holder = rows.find((r) => r.current) ?? rows[0];
	if (!holder) return { status: 'available', name: v.name };
	if (holder.owner !== memberId) return { status: 'taken', name: v.name };
	// A retired name of one's own is free to take back.
	return { status: holder.current ? 'yours' : 'available', name: v.name };
}

// Usernames of the given members, keyed by id, for links built by someone
// allowed to open profiles. Kept apart from listPublicMembers so the payload a
// guest receives never carries a chosen name.
export async function usernamesFor(
	groupId: string,
	ids: readonly string[]
): Promise<Record<string, string>> {
	if (!ids.length) return {};
	const { rows } = await query<{ id: string; username: string }>(
		`SELECT id::text AS id, username::text AS username FROM member
		  WHERE group_id = $1 AND id = ANY($2::uuid[]) AND username IS NOT NULL`,
		[groupId, ids]
	);
	return Object.fromEntries(rows.map((r) => [r.id, r.username]));
}

// The names this member gave up, newest first, for the admin's view of them.
export async function retiredUsernames(groupId: string, memberId: string): Promise<string[]> {
	const { rows } = await query<{ username: string }>(
		`SELECT username::text AS username FROM member_username_retired
		  WHERE group_id = $1 AND member_id = $2
		  ORDER BY retired_at DESC, username`,
		[groupId, memberId]
	);
	return rows.map((r) => r.username);
}

// An admin frees a retired name: its old links stop resolving and anyone may
// claim it. Returns whether a row was released.
export async function releaseUsernameIn(
	client: Client,
	r: { group: GroupRef; memberId: string; username: string; actor: Actor }
): Promise<boolean> {
	await client.query(GROUP_LOCK_SQL, [r.group.id]);
	const { rows } = await client.query<{ username: string }>(
		`DELETE FROM member_username_retired
		  WHERE group_id = $1 AND member_id = $2 AND username = $3
		  RETURNING username::text AS username`,
		[r.group.id, r.memberId, r.username]
	);
	if (!rows.length) return false;
	await auditIn(client, {
		...r.actor,
		category: 'data',
		action: 'member.username-released',
		groupId: r.group.id,
		groupSlug: r.group.slug,
		targetId: r.memberId,
		before: { username: rows[0].username },
		after: {},
		meta: {}
	});
	return true;
}
