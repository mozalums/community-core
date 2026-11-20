import { query } from '$lib/server/postgres';
import type { AuditEntry } from '$lib/server/audit-core';
import { log } from '$lib/server/log';
import { bindSubject } from '$lib/server/member-write';
import { emailMd5, ensureAvatarRows } from '$lib/server/avatars';
import {
	CHECKED_SQL_VALUES,
	DEFAULT_FIELD_SCHEMA,
	isMembersVisibleKey,
	membersVisibleKeys,
	optionalFieldByRole,
	promotedKeys,
	type FieldRole,
	type PromotedColumn
} from '$lib/server/field-schema';

export type Actor = Pick<AuditEntry, 'actorSubject' | 'actorEmail'>;

export type Member = {
	id: string;
	groupId: string;
	email: string;
	identSubject: string | null;
	name: string | null;
	city: string | null;
	linkedin: string | null;
	// Members-visible field values, keyed by field-schema key.
	data: Record<string, unknown>;
	status: string;
};

type MemberRow = {
	id: string;
	group_id: string;
	email: string;
	ident_subject: string | null;
	name: string | null;
	city: string | null;
	linkedin: string | null;
	data: Record<string, unknown>;
	status: string;
};

function mapMember(r: MemberRow): Member {
	return {
		id: r.id,
		groupId: r.group_id,
		email: r.email,
		identSubject: r.ident_subject,
		name: r.name,
		city: r.city,
		linkedin: r.linkedin,
		data: r.data ?? {},
		status: r.status
	};
}

const SELECT_COLS = `id, group_id, email, ident_subject, name, city, linkedin, data, status`;

// A member with the admin-only values, which only the single-profile read
// loads. Lists and search never select private_data, so no directory payload
// can carry it by accident.
export type MemberWithPrivate = Member & {
	privateData: Record<string, unknown>;
};

const CHECKED_SQL = `(${CHECKED_SQL_VALUES.map((v) => `'${v}'`).join(', ')})`;

export type PublicMember = {
	id: string;
	name: string;
	avatarId: string | null;
};

// Members who opted in to appearing on public pages (the publicProfile-role
// checkbox in data, read back as TRUE). Name + the photo's URL id, joined
// here so the showcase renders in one round trip. Ordered by name for a stable
// homepage showcase.
//
// Neither the address nor a hash of it leaves this function. Every caller
// renders a page a guest can reach, and the opt-in they are relying on says
// "your name and photo may appear on the public homepage" — so the payload is a
// name and a photo. The hash used to ship for the Gravatar fallback, which sent
// a guest's browser to Automattic once per member, published the roster to a
// party none of these people chose, and let anyone holding a candidate address
// confirm membership by hashing it. The photo now comes from our own origin at
// /avatar/<public id>, fetched server-side, so the showcase shows the same faces
// with none of that.
//
// The `ensureAvatarRows` call is a write on a read path, which is deliberate and
// bounded: a member has no `public_id` until a row exists, and the id is the
// only address-free way to name their image in a URL. It inserts nothing after
// the first sighting of each address, so a guest reloading the page performs one
// no-op statement rather than a write per load.
export async function listPublicMembers(groupId: string): Promise<PublicMember[]> {
	// A skin with no opt-in field has nobody who opted in.
	const optIn = optionalFieldByRole('publicProfile');
	if (!optIn) return [];
	const { rows } = await query<{
		id: string;
		name: string | null;
		email: string;
		public_id: string | null;
	}>(
		`SELECT m.id, m.name, m.email, a.public_id
		   FROM member m
		   LEFT JOIN member_avatar a ON a.email = m.email
		  WHERE m.group_id = $1 AND m.status = 'active'
		    AND lower(btrim(coalesce(m.data->>$2, ''))) IN ${CHECKED_SQL}
		  ORDER BY lower(m.name) NULLS LAST, lower(m.email)`,
		[groupId, optIn.key]
	);

	// Only addresses with no row at all. After the first load this list is empty
	// and the call short-circuits without touching Postgres.
	const missing = rows.filter((r) => !r.public_id).map((r) => r.email);
	const created = missing.length
		? await ensureAvatarRows(missing).catch((e) => {
				// A failure here costs photos, not the page. The showcase still
				// renders every member with an initials disc.
				log.warn('avatar.ensure-rows-failed', { groupId, error: String(e) });
				return new Map<string, string>();
			})
		: new Map<string, string>();

	return rows.map((r) => ({
		id: r.id,
		name: r.name ?? '',
		avatarId: r.public_id ?? created.get(emailMd5(r.email)) ?? null
	}));
}

// Resolve the signed-in identity to an active member of this group. Matches
// on ident_subject first (the durable OIDC link), then falls back to email
// (the Google-Form identity). On a first-time email match with no bound
// subject yet, bind it so subsequent logins resolve by subject directly, and
// report `firstLogin: true` for that one request — the binding only happens
// once, so callers use it to send a brand-new member to their profile.
export async function resolveMember(
	groupId: string,
	email: string | null | undefined,
	subject: string | null | undefined
): Promise<{ member: Member | null; firstLogin: boolean }> {
	if (subject) {
		const bySubject = await query<MemberRow>(
			`SELECT ${SELECT_COLS} FROM member
			  WHERE group_id = $1 AND ident_subject = $2 AND status = 'active'`,
			[groupId, subject]
		);
		if (bySubject.rows[0]) return { member: mapMember(bySubject.rows[0]), firstLogin: false };
	}

	if (email) {
		const byEmail = await query<MemberRow>(
			`SELECT ${SELECT_COLS} FROM member
			  WHERE group_id = $1 AND email = $2 AND status = 'active'`,
			[groupId, email]
		);
		const row = byEmail.rows[0];
		if (row) {
			let firstLogin = false;
			if (subject && !row.ident_subject) {
				try {
					// True → *this* request bound it (first login). False → a
					// concurrent login bound it first, so it's not our first login.
					firstLogin = await bindSubject({
						groupId,
						memberId: row.id,
						email: row.email,
						subject,
						actor: { actorSubject: subject, actorEmail: email }
					});
					row.ident_subject = subject;
					log.info('member.bind-subject', { groupId, memberId: row.id, subject, firstLogin });
				} catch (e) {
					// Non-fatal: the bind and its audit row rolled back together, so
					// the member stays unbound and the next login tries again.
					// Access is still granted this request via the email match.
					log.warn('member.bind-subject-failed', { groupId, memberId: row.id, error: e as Error });
				}
			}
			return { member: mapMember(row), firstLogin };
		}
	}

	return { member: null, firstLogin: false };
}

// Whether `user` may edit this member: a group admin, or the member themselves
// (matched on the durable OIDC subject, falling back to email).
export function canEditMember(
	member: Pick<Member, 'identSubject' | 'email'>,
	user: { subject: string; email: string } | null | undefined,
	isAdmin: boolean
): boolean {
	if (isAdmin) return true;
	if (!user) return false;
	if (member.identSubject && member.identSubject === user.subject) return true;
	if (member.email && user.email && member.email.toLowerCase() === user.email.toLowerCase()) {
		return true;
	}
	return false;
}

// Single active member by id, scoped to the group (for the profile page).
export async function getMemberById(
	groupId: string,
	id: string
): Promise<MemberWithPrivate | null> {
	const { rows } = await query<MemberRow & { private_data: Record<string, unknown> | null }>(
		`SELECT ${SELECT_COLS}, private_data
		   FROM member
		  WHERE group_id = $1 AND id = $2 AND status = 'active'`,
		[groupId, id]
	);
	const r = rows[0];
	return r ? { ...mapMember(r), privateData: r.private_data ?? {} } : null;
}

// M1: full active-member list for the directory.
export async function listMembers(groupId: string): Promise<Member[]> {
	const { rows } = await query<MemberRow>(
		`SELECT ${SELECT_COLS} FROM member
		  WHERE group_id = $1 AND status = 'active'
		  ORDER BY lower(name) NULLS LAST, lower(email)`,
		[groupId]
	);
	return rows.map(mapMember);
}

// Active-member count for the directory sidebar (cheap; runs on every gated page).
export async function countMembers(groupId: string): Promise<number> {
	const { rows } = await query<{ n: number }>(
		`SELECT count(*)::int AS n FROM member WHERE group_id = $1 AND status = 'active'`,
		[groupId]
	);
	return Number(rows[0]?.n ?? 0);
}

const RESULT_CAP = 200;

// M3: directory search. `city` is a substring filter (ILIKE) — predictable
// for "everyone in Berlin". `q` is free-form and every token in it has to earn
// its place: any 4-digit year (yyyy) is pulled OUT and applied as an AND filter
// (tenure must span it — Start Year ≤ yyyy ≤ End Year, a missing/non-numeric
// bound treated as open, no End Year = still around), and each remaining word
// gets its own OR block, AND'd with the others. So "london fellow" means
// London AND Fellow, not "London, and never mind the rest".
//
// A word's OR block is every way one word can match: a websearch tsquery over
// visible_tsv (whole words; also drives ranking), a
// case-insensitive SUBSTRING (ILIKE) on name/city/linkedin AND every data
// field VALUE (handle, projects, companies, country, …) so a fragment like
// "popcorn" finds "popcornjs", and a trigram match on name/city/handle for typo
// tolerance. A data value or a checkbox is searched only under a key
// membersVisibleKeys names, the set the profile shows a non-admin, so a value
// left in `data` under a key the skin has since made private is not searchable
// even though no write path puts one there. Only values are searched (never
// the keys), so "country" doesn't match every row. Naming a checkbox field by
// its label (fellow, volunteer, …) matches members who have it checked.
//
// The word reaches every ILIKE with `%`, `_` and `\` escaped. Unescaped, they
// are wildcards, and the result count turns any searchable value into one a
// member can read back a character at a time.
//
// Fields are found by role, never by key text: the tenure span reads whatever
// field holds tenureStart and tenureEnd, the trigram whatever holds handle.
//
// A word at a time is what makes those last two work for a multi-word query:
// against the whole phrase, no field holds "london fellow" as a substring and
// no column is named it, so the only clause that could still fire was the
// trigram one — and `similarity('London', 'london fellow')` cleared the 0.3
// threshold. Every London member came back as a Fellow match.
//
// AND can find nothing, though, where the old OR always found something. If no
// member matches every word, the search runs again joining the same blocks with
// OR and reports `relaxed` so the page can say the terms were loosened rather
// than quietly answering a different question. Results are ranked (ts_rank when
// free text present) and capped — at alumni scale paging isn't needed yet, but
// the cap bounds it.
export type MemberSearch = { members: Member[]; relaxed: boolean };

export async function searchMembers(
	groupId: string,
	opts: { city?: string; q?: string }
): Promise<MemberSearch> {
	const city = opts.city?.trim();
	const q = opts.q?.trim();

	// A role or typed column reaches the query only when the profile shows
	// every field behind it to a non-admin. A private one reads as absent, so a
	// year beside one private tenure bound is a word, and a column that joins a
	// private field is left to the data clauses, which see its visible parts.
	const visibleRole = (role: FieldRole) => {
		const f = optionalFieldByRole(role);
		return f && isMembersVisibleKey(f.key) ? f : undefined;
	};
	const columnSearchable = (c: PromotedColumn) => {
		const keys = promotedKeys(c);
		return keys.length > 0 && keys.every((k) => isMembersVisibleKey(k));
	};
	const columns = (['name', 'city', 'linkedin'] as const).filter(columnSearchable);
	const searchesCity = columns.includes('city');

	// A year filters on the tenure span, which takes both of the skin's tenure
	// fields. Without them a year is a word like any other.
	const tenureStart = visibleRole('tenureStart');
	const tenureEnd = visibleRole('tenureEnd');
	const handle = visibleRole('handle');
	const isYear = (t: string) => !!tenureStart && !!tenureEnd && /^(19|20)\d{2}$/.test(t);
	const tokens = q ? q.split(/\s+/).filter(Boolean) : [];
	const years = tokens.filter(isYear);
	const terms = tokens.filter((t) => !isYear(t));

	// The members-visible checkboxes whose label contains the word, so "fell"
	// finds everyone who ticked Fellow.
	const checkboxKeysNamed = (t: string) =>
		DEFAULT_FIELD_SCHEMA.filter(
			(f) =>
				f.type === 'checkbox' &&
				isMembersVisibleKey(f.key) &&
				f.label.toLowerCase().includes(t.toLowerCase())
		).map((f) => f.key);
	const like = (t: string) => `%${t.replace(/[\\%_]/g, '\\$&')}%`;

	// Every way a single word can match a member. `p` is the placeholder holding
	// that word — one word, never the phrase, which is the whole point.
	const field = (keyParam: string) => `member.data->>${keyParam}`;
	const termBlock = (
		p: string,
		sub: string,
		checkboxKeys: string,
		visibleKeys: string,
		handleKey: string | null
	) => {
		return `(
			visible_tsv @@ websearch_to_tsquery('simple', ${p})
			${columns.map((c) => `OR ${c} ILIKE ${sub} ESCAPE '\\'`).join('\n')}
			OR EXISTS (
			     SELECT 1 FROM jsonb_each_text(member.data) AS f(k, v)
			      WHERE f.k = ANY(${visibleKeys}::text[]) AND v ILIKE ${sub} ESCAPE '\\'
			   )
			OR EXISTS (
			     SELECT 1 FROM unnest(${checkboxKeys}::text[]) AS c(k)
			      WHERE lower(btrim(coalesce(${field('c.k')}, ''))) IN ${CHECKED_SQL}
			   )
			${columns
				.filter((c) => c !== 'linkedin')
				.map((c) => `OR ${c} % ${p}`)
				.join('\n')}
			${handleKey ? `OR coalesce(${field(handleKey)}, '') % ${p}` : ''}
		)`;
	};

	const run = async (join: 'AND' | 'OR'): Promise<Member[]> => {
		const where: string[] = [`group_id = $1`, `status = 'active'`];
		const params: unknown[] = [groupId];
		const param = (v: unknown) => {
			params.push(v);
			return `$${params.length}`;
		};

		if (city) {
			where.push(searchesCity ? `city ILIKE ${param(like(city))} ESCAPE '\\'` : 'FALSE');
		}

		// With no free text there's no relevance score. It can't be `0` (a bare
		// integer in ORDER BY is read as an ordinal column position → error) nor a
		// bare `NULL` (rejected as a non-integer constant); a typed NULL sorts all
		// rows equal so the name/email tiebreak orders them.
		let rankExpr = `NULL::float`;
		const and: string[] = [];

		// One tenure-span clause per year, always AND'd — a year is a filter in
		// both passes, never something the fallback loosens.
		if (years.length && tenureStart && tenureEnd) {
			const start = field(param(tenureStart.key));
			const end = field(param(tenureEnd.key));
			for (const y of years) {
				const yr = param(Number(y));
				and.push(
					`(
					  ((${start}) ~ '^[0-9]{4}$' OR (${end}) ~ '^[0-9]{4}$')
					  AND ((${start}) !~ '^[0-9]{4}$' OR (${start})::int <= ${yr})
					  AND ((${end}) !~ '^[0-9]{4}$' OR (${end})::int >= ${yr})
					)`
				);
			}
		}

		let from = 'member';
		if (terms.length) {
			const handleKey = handle ? param(handle.key) : null;
			const visibleKeys = param(membersVisibleKeys());
			// The stored search_tsv indexes every value in data, whatever its key,
			// so whole-word matching and ranking read this one instead: the same
			// expression over the allowlisted keys alone. The ILIKE clauses already
			// scan every row, so giving up the GIN index costs no plan it had.
			from = `member CROSS JOIN LATERAL (
			    SELECT to_tsvector('simple',
			        ${columns.map((c) => `coalesce(${c}, '') || ' ' || `).join('')}
			        member_search_values((
			            SELECT coalesce(jsonb_object_agg(e.k, e.v), '{}'::jsonb)
			              FROM jsonb_each(member.data) AS e(k, v)
			             WHERE e.k = ANY(${visibleKeys}::text[])
			        ))) AS visible_tsv
			  ) AS vis`;
			const blocks = terms.map((t) =>
				termBlock(param(t), param(like(t)), param(checkboxKeysNamed(t)), visibleKeys, handleKey)
			);
			and.push(`(${blocks.join(` ${join} `)})`);
			// Ranking reads the whole query even when the blocks are OR'd: a row
			// that matched more of it outranks one that matched a single word.
			params.push(terms.join(' '));
			rankExpr = `ts_rank(visible_tsv, websearch_to_tsquery('simple', $${params.length}))`;
		}

		if (and.length) where.push(`(${and.join(' AND ')})`);

		params.push(RESULT_CAP);
		const { rows } = await query<MemberRow>(
			`SELECT ${SELECT_COLS}
			   FROM ${from}
			  WHERE ${where.join(' AND ')}
			  ORDER BY ${rankExpr} DESC, lower(name) NULLS LAST, lower(email)
			  LIMIT $${params.length}`,
			params
		);
		return rows.map(mapMember);
	};

	const members = await run('AND');
	// Nothing to loosen unless there were several words to require at once: one
	// word AND'd and OR'd is the same query, and an empty result for it is the
	// honest answer.
	if (members.length || terms.length < 2) return { members, relaxed: false };

	const any = await run('OR');
	return { members: any, relaxed: any.length > 0 };
}
