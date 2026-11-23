import { query } from '$lib/server/postgres';
import type { AuditEntry } from '$lib/server/audit-core';
import { log } from '$lib/server/log';
import { bindSubject } from '$lib/server/member-write';
import { emailMd5, ensureAvatarRows } from '$lib/server/avatars';
import { isUuid } from '$lib/group-nav';
import {
	CHECKED_SQL_VALUES,
	DEFAULT_FIELD_SCHEMA,
	filterFields,
	isMembersVisibleKey,
	membersVisibleKeys,
	optionalFieldByRole,
	filterColumn,
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
	// Members-visible field values, keyed by field-schema key.
	data: Record<string, unknown>;
	status: string;
	// The member's chosen profile URL name, when they picked one; else their
	// profile lives at the uuid. Optional in the type so a fixture that predates
	// usernames still describes a member without one.
	username?: string | null;
};

type MemberRow = {
	id: string;
	group_id: string;
	email: string;
	ident_subject: string | null;
	name: string | null;
	city: string | null;
	data: Record<string, unknown>;
	status: string;
	username: string | null;
};

function mapMember(r: MemberRow): Member {
	return {
		id: r.id,
		groupId: r.group_id,
		email: r.email,
		identSubject: r.ident_subject,
		name: r.name,
		city: r.city,
		data: r.data ?? {},
		status: r.status,
		username: r.username ?? null
	};
}

const SELECT_COLS = `id, group_id, email, ident_subject, name, city, data, status, username::text AS username`;

// A member with the admin-only values, which only the single-profile read
// loads. Lists and search never select private_data, so no directory payload
// can carry it by accident.
export type MemberWithPrivate = Member & {
	privateData: Record<string, unknown>;
};

const CHECKED_SQL = `(${CHECKED_SQL_VALUES.map((v) => `'${v}'`).join(', ')})`;
// The values member_search_values (migrations.ts) drops as markers rather
// than words; search reads checkbox values against the same list.
const MARKER_SQL = `('true', 'false', 'yes', 'no', 'y', 'n', 'x', '1', '0', 'checked', 'on')`;

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

// Single active member, scoped to the group, by the `[id]` segment of a profile
// URL: a uuid, the member's current username, or a username they retired. The
// caller compares memberRef(result) with what it was given to tell the
// canonical form from one that should redirect.
//
// A non-ASCII segment resolves to nothing before it reaches citext, whose case
// fold would turn a look-alike (the Kelvin sign) into the ASCII name it mimics;
// no username can hold one, so refusing it here hides no member.
export async function getMemberById(
	groupId: string,
	ref: string
): Promise<MemberWithPrivate | null> {
	// eslint-disable-next-line no-control-regex
	if (/[^\x00-\x7f]/.test(ref)) return null;
	type Row = MemberRow & { private_data: Record<string, unknown> | null };
	const cols = SELECT_COLS.split(', ')
		.map((c) => `m.${c}`)
		.join(', ');
	const { rows } = isUuid(ref)
		? await query<Row>(
				`SELECT ${cols}, m.private_data
				   FROM member m
				  WHERE m.group_id = $1 AND m.id = $2 AND m.status = 'active'`,
				[groupId, ref]
			)
		: await query<Row>(
				`SELECT ${cols}, m.private_data
				   FROM member m
				  WHERE m.group_id = $1 AND m.status = 'active'
				    AND (m.username = $2
				         OR m.id = (SELECT r.member_id FROM member_username_retired r
				                     WHERE r.group_id = $1 AND r.username = $2))
				  ORDER BY (m.username = $2) DESC NULLS LAST
				  LIMIT 1`,
				[groupId, ref]
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
// A word's OR block is every way one word can match exactly: a websearch
// tsquery over visible_tsv (whole words), a case-insensitive SUBSTRING (ILIKE)
// on name/city AND every data field VALUE (handle, projects,
// companies, country, …) so a fragment like "popcorn" finds "popcornjs". A data
// value or a checkbox is searched only under a key membersVisibleKeys names,
// the set the profile shows a non-admin, so a value left in `data` under a key
// the skin has since made private is not searchable even though no write path
// puts one there. Only values are searched (never the keys), so "country"
// doesn't match every row. Naming a checkbox field by its label (fellow,
// volunteer, …) matches members who have it checked.
//
// The word reaches every ILIKE with `%`, `_` and `\` escaped. Unescaped, they
// are wildcards, and the result count turns any searchable value into one a
// member can read back a character at a time.
//
// Fields are found by role, never by key text: the tenure span reads whatever
// field holds tenureStart and tenureEnd, the trigram whatever holds handle.
//
// A word at a time is what makes the year and checkbox clauses work for a
// multi-word query: against the whole phrase, no field holds "london fellow"
// as a substring and no column is named it.
//
// AND can find nothing, though, where the old OR always found something. If no
// member matches every word, the search runs again joining the same blocks with
// OR and reports `relaxed` so the page can say the terms were loosened rather
// than quietly answering a different question.
//
// Trigram similarity (pg_trgm `%`, threshold 0.3) on name, city and handle is
// there to forgive a misspelt name, and it runs only when the exact passes
// found nobody, reported as `fuzzy`. In the same block as the exact clauses it
// let any short value sharing three letters with a word through: "carlo"
// against "cars" scores about 0.375, so every Carlo answered a search for cars.
//
// Each hit carries `matched`: per visible field, the query words its value
// held, so a tile can say why the member is there. It reads the same key list
// as the match clauses, so a private field never matches and is never named.
//
// `filters` are field filters: each names a field the skin marks
// `filter: exact` and a value, and matches only members whose stored value
// for that field equals it, case-insensitive after NFKC and trim. A key that
// is not such a field is dropped here as well as by the caller. Filters sit in
// the WHERE beside `group_id`, outside the word blocks, so neither the relaxed
// nor the fuzzy pass loosens them: with a filter and no match, the answer is
// nobody.
//
// Results are ranked whole-word name match first, then any other whole-word
// match, then a substring match, then ts_rank, then name, and capped: at
// alumni scale paging isn't needed yet, but the cap bounds it.
export type SearchMatch = { label: string; words: string[] };

// The query as words: NFKC turns compatibility forms (fullwidth letters,
// ligatures) into the characters stored text uses, then lowercase, then
// whitespace. A token with no letter or digit (an emoji, a lone dash) holds
// nothing a field could match, and as its own AND'd block it would empty the
// results, so it is dropped. A query that drops every token searches nothing.
// A tile shows the word as typed, so each token keeps its case beside the
// form it matches with; lowercasing adds or removes no whitespace, so the two
// splits line up.
type QueryWord = { term: string; typed: string };
function queryWords(q: string | undefined): QueryWord[] {
	const nfkc = (q ?? '').normalize('NFKC');
	const typed = nfkc.split(/\s+/u);
	return nfkc
		.toLowerCase()
		.split(/\s+/u)
		.map((term, i) => ({ term, typed: typed[i] }))
		.filter((w) => /[\p{L}\p{N}]/u.test(w.term));
}
export const searchTokens = (q: string | undefined): string[] => queryWords(q).map((w) => w.term);
export type SearchHit = Member & { matched: SearchMatch[] };
export type MemberSearch = { members: SearchHit[]; relaxed: boolean; fuzzy: boolean };
export type FieldFilter = { key: string; value: string };

// What String.prototype.trim strips, as a PostgreSQL regex. The query and the
// profile trim in JavaScript, so a stored value folded for an exact filter has
// to lose the same characters; PostgreSQL's \s keeps U+FEFF, and a value
// padded with it would show on the profile and never be found by its link.
const JS_TRIM_PATTERN = (() => {
	let cls = '';
	for (let c = 1; c <= 0xffff; c++) {
		if (String.fromCharCode(c).trim() === '') cls += `\\u${c.toString(16).padStart(4, '0')}`;
	}
	return `^[${cls}]+|[${cls}]+$`;
})();

export async function searchMembers(
	groupId: string,
	opts: { city?: string; q?: string; filters?: readonly FieldFilter[] }
): Promise<MemberSearch> {
	const city = opts.city?.normalize('NFKC').trim();
	const filterable = filterFields();
	const filters = (opts.filters ?? []).flatMap(({ key, value }) => {
		const f = filterable.find((x) => x.key === key);
		const v = value.normalize('NFKC').trim();
		return f && v ? [{ field: f, value: v }] : [];
	});

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
	const columns = (['name', 'city'] as const).filter(columnSearchable);
	const searchesCity = columns.includes('city');

	// A year filters on the tenure span, which takes both of the skin's tenure
	// fields. Without them a year is a word like any other.
	const tenureStart = visibleRole('tenureStart');
	const tenureEnd = visibleRole('tenureEnd');
	const handle = visibleRole('handle');
	const isYear = (t: string) => !!tenureStart && !!tenureEnd && /^(19|20)\d{2}$/.test(t);
	const tokens = queryWords(opts.q);
	const years = tokens.map((w) => w.term).filter(isYear);
	const wordTokens = tokens.filter((w) => !isYear(w.term));
	const terms = wordTokens.map((w) => w.term);
	const typedTerms = wordTokens.map((w) => w.typed);

	// What a tile calls a field. A key that feeds a searched column is named by
	// the column, so a match on "givenName" reads as Name, once.
	const labelOf = (key: string) => DEFAULT_FIELD_SCHEMA.find((f) => f.key === key)?.label ?? key;
	const columnLabel = (c: PromotedColumn) => {
		const keys = promotedKeys(c);
		return keys.length === 1 || c !== 'name' ? labelOf(keys[0]) : 'Name';
	};
	const columnOf = new Map(columns.flatMap((c) => promotedKeys(c).map((k) => [k, c] as const)));
	const visible = membersVisibleKeys();
	const visibleLabels = visible.map((k) => {
		const c = columnOf.get(k);
		return c ? columnLabel(c) : labelOf(k);
	});

	// Every members-visible checkbox. Which of them a word names is decided in
	// SQL, under the same fold as every other comparison, so "fell" finds
	// everyone who ticked Fellow and an accent on either side changes nothing.
	const boxes = DEFAULT_FIELD_SCHEMA.filter(
		(f) => f.type === 'checkbox' && isMembersVisibleKey(f.key)
	);
	// Both sides of every comparison fold the same way: NFC, so a value an
	// older import stored decomposed still matches; lowercase; then accents
	// off. Stored data is never rewritten. A word is folded before it is
	// escaped for ILIKE, and both happen in SQL, because unaccent can turn a
	// character into a wildcard or the escape (∖ reads as a backslash).
	const fold = (value: string) => `search_unaccent(lower(normalize(${value}, NFC)))`;
	const likeOf = (p: string) =>
		`('%' || regexp_replace(search_unaccent(${p}), '([\\\\%_])', '\\\\\\1', 'g') || '%')`;
	const field = (keyParam: string) => `member.data->>${keyParam}`;
	const isTrue = (b: string) => `coalesce((${b}), FALSE)`;

	const run = async (join: 'AND' | 'OR', fuzzy: boolean): Promise<SearchHit[]> => {
		const where: string[] = [`group_id = $1`, `status = 'active'`];
		const params: unknown[] = [groupId];
		const param = (v: unknown) => {
			params.push(v);
			return `$${params.length}`;
		};

		// The field's own value, as the profile links it: the city column for
		// the city field (filterColumn), else the data value at its key. A blank value folds to
		// '' or NULL, and a filter value is never blank, so it matches nothing.
		if (filters.length) {
			const trim = param(JS_TRIM_PATTERN);
			const exactFold = (v: string) =>
				`lower(regexp_replace(normalize(${v}, NFKC), ${trim}, '', 'g'))`;
			for (const { field: f, value } of filters) {
				const data = exactFold(`member.data->>${param(f.key)}`);
				const own = filterColumn(f);
				const stored = own ? `coalesce(nullif(${exactFold(`member.${own}`)}, ''), ${data})` : data;
				where.push(`${stored} = ${exactFold(param(value))}`);
			}
		}

		if (city) {
			where.push(
				searchesCity ? `${fold('city')} ILIKE ${likeOf(param(city))} ESCAPE '\\'` : 'FALSE'
			);
		}

		// With no free text there's no relevance score. It can't be `0` (a bare
		// integer in ORDER BY is read as an ordinal column position → error) nor a
		// bare `NULL` (rejected as a non-integer constant); a typed NULL sorts all
		// rows equal so the name/email tiebreak orders them.
		let rankExpr = `NULL::float`;
		let order: string[] = [];
		let matchedExpr = `'[]'::jsonb`;
		const and: string[] = [];

		// One tenure-span clause per year, always AND'd — a year is a filter in
		// both passes, never something the fallback loosens. A bound that is
		// missing, empty or not four digits is open on its side (no end year
		// means still around), but at least one bound must be a valid year. The
		// CASE keeps the cast away from non-year text, which an OR does not
		// promise, and coalesce keeps a missing bound from turning the clause
		// NULL, which WHERE would drop.
		if (years.length && tenureStart && tenureEnd) {
			const start = field(param(tenureStart.key));
			const end = field(param(tenureEnd.key));
			const valid = (v: string) => `coalesce((${v}) ~ '^[0-9]{4}$', false)`;
			for (const y of years) {
				const yr = param(Number(y));
				and.push(
					`(
					  (${valid(start)} OR ${valid(end)})
					  AND CASE WHEN ${valid(start)} THEN (${start})::int <= ${yr} ELSE TRUE END
					  AND CASE WHEN ${valid(end)} THEN (${end})::int >= ${yr} ELSE TRUE END
					)`
				);
			}
		}

		let from = 'member';
		if (terms.length) {
			const visibleKeys = param(visible);
			// Whether a value is words follows the type its field declares. A
			// checkbox stores a marker ("on", "TRUE") that would match every
			// member who ticked it, so its label carries it instead; any other
			// field's text is words, even when it spells a marker.
			const checkboxKeys = param(
				visible.filter((k) => DEFAULT_FIELD_SCHEMA.find((f) => f.key === k)?.type === 'checkbox')
			);
			// Every value is read inline, never through member_search_values or
			// member_value_text: those are SQL functions Postgres cannot inline
			// (they aggregate), each call costs milliseconds, and calling them
			// per value per member made a search take seconds.
			const linksKeys = param(
				visible.filter((k) => DEFAULT_FIELD_SCHEMA.find((f) => f.key === k)?.type === 'links')
			);
			const lexicalText = (k: string, v: string) => `CASE WHEN ${k} = ANY(${checkboxKeys}::text[])
			    THEN CASE WHEN lower(btrim(coalesce(${v} #>> '{}', ''))) IN ${MARKER_SQL}
			              THEN '' ELSE coalesce(${v} #>> '{}', '') END
			    WHEN ${k} = ANY(${linksKeys}::text[])
			    THEN translate(jsonb_path_query_array(${v}, '$[*].handle')::text, '[]",', '    ')
			    ELSE coalesce(${v} #>> '{}', '') END`;
			const labels = param(visibleLabels);
			const boxKeys = param(boxes.map((f) => f.key));
			const boxLabels = param(boxes.map((f) => f.label));
			const handleKey = fuzzy && handle ? param(handle.key) : null;
			const nameKeys = param(promotedKeys('name').filter((k) => isMembersVisibleKey(k)));
			const colLabel = Object.fromEntries(columns.map((c) => [c, param(columnLabel(c))]));
			// The stored search_tsv indexes every value in data, whatever its key,
			// so whole-word matching and ranking read this one instead: the same
			// expression over the allowlisted keys alone. The ILIKE clauses already
			// scan every row, so giving up the GIN index costs no plan it had.
			// OFFSET 0 keeps the planner from pulling the subquery up and
			// recomputing visible_tsv at each of its references.
			from = `member CROSS JOIN LATERAL (
			    SELECT to_tsvector('simple', ${fold(`
			        ${columns.map((c) => `coalesce(${c}, '') || ' ' || `).join('')}
			        (SELECT coalesce(string_agg(${lexicalText('e.k', 'e.v')}, ' '), '')
			           FROM jsonb_each(member.data) AS e(k, v)
			          WHERE e.k = ANY(${visibleKeys}::text[])
			        )`)}) AS visible_tsv
			    OFFSET 0
			  ) AS vis`;

			// Every way one word can match a member, per visible field: whole
			// word, substring, and in the typo pass trigram. The WHERE block, the
			// labels a tile shows and the rank tiers are all built from these, so a
			// member is never let in by a reason that names no field or ranks in a
			// tier its fields don't support. `p` holds one word, never the phrase.
			const words = terms.map((t) => {
				const p = param(t);
				const sub = likeOf(p);
				const tsq = `websearch_to_tsquery('simple', search_unaccent(${p}))`;
				// A word typed as "-x" parses to a negation, which every field lacking
				// x satisfies. It stays a filter on the whole member over visible_tsv,
				// AND'd in both passes like a year, so the relaxed pass never turns
				// it into a reason to include. No field matched it: it names none and
				// lifts no rank tier. querytree() reads 'T' for a negation-only query.
				const negated = `querytree(${tsq}) = 'T'`;
				// A whole-word match is member-wide, as the word was typed: one
				// token can parse to several lexemes ("astronomy,cars" reads as
				// astronomy <-> cars), and those may sit in different fields. A
				// field takes part in it when it holds one of the token's lexemes,
				// which inside one token are all required, never negated.
				const lexemes = `tsvector_to_array(to_tsvector('simple', search_unaccent(${p})))`;
				const whole = (text: string) =>
					`(visible_tsv @@ ${tsq} AND tsvector_to_array(to_tsvector('simple', ${fold(text)})) && ${lexemes})`;
				const unlessNegated = (x: string) => `(NOT ${negated} AND ${x})`;
				const substr = (text: string) => `${fold(text)} ILIKE ${sub} ESCAPE '\\'`;
				const checked = (k: string) => `lower(btrim(coalesce(${field(k)}, ''))) IN ${CHECKED_SQL}`;
				const any = (xs: string[]) => (xs.length ? `(${xs.join(' OR ')})` : 'FALSE');

				// A data value is read the way visible_tsv reads it, so admission,
				// labels and rank agree on which of its words count.
				const keyText = lexicalText('l.k', 'member.data->l.k');
				const colWhole = (c: PromotedColumn) => whole(`coalesce(${c}, '')`);
				const colSub = (c: PromotedColumn) => substr(c);
				const colClose = (c: PromotedColumn) => (fuzzy ? `${c} % ${p}` : 'FALSE');
				const keyWhole = whole(keyText);
				const keySub = substr(keyText);
				const keyClose = handleKey
					? `(l.k = ${handleKey} AND coalesce(${field('l.k')}, '') % ${p})`
					: 'FALSE';
				// A box takes part in a word only when its label holds the word, so
				// a whole-word label match is the narrower case of a substring one.
				const boxSub = substr('b.label');
				const boxWhole = `(${boxSub} AND to_tsvector('simple', ${fold('b.label')}) @@ ${tsq})`;

				const keys = (cond: string) => `EXISTS (
					     SELECT 1 FROM unnest(${visibleKeys}::text[]) AS l(k) WHERE ${cond}
					   )`;
				const checkedBox = (cond: string) => `EXISTS (
					     SELECT 1 FROM unnest(${boxKeys}::text[], ${boxLabels}::text[]) AS b(k, label)
					      WHERE ${checked('b.k')} AND ${cond}
					   )`;

				// A checked box holds its label's words, so negating a label excludes
				// everyone who ticked it. The label is read as for a positive word,
				// a substring gate then the whole word, with the "-" left off the gate.
				const negatedBox = t.startsWith('-')
					? checkedBox(`${fold('b.label')} ILIKE ${likeOf(param(t.replace(/^-+/, '')))} ESCAPE '\\'
					      AND NOT to_tsvector('simple', ${fold('b.label')}) @@ ${tsq}`)
					: 'FALSE';
				const filter = `(NOT ${negated} OR (visible_tsv @@ ${tsq} AND NOT ${negatedBox}))`;

				const wholeWord = unlessNegated(
					any([...columns.map(colWhole), keys(keyWhole), checkedBox(boxWhole)])
				);
				// A checked box whose label merely contains the word ("fell" in
				// Fellow) is a substring match; one whose label is the word ranked
				// above as whole-word.
				const substring = unlessNegated(
					any([...columns.map(colSub), keys(keySub), checkedBox(boxSub)])
				);
				const close = unlessNegated(any([...columns.map(colClose), keys(keyClose)]));
				const block = `(${wholeWord} OR ${substring} OR ${close})`;

				// The labels of the fields this word matched, columns first, then
				// data keys and checkboxes in schema order.
				const colHit = (c: PromotedColumn) => `${colWhole(c)} OR ${colSub(c)} OR ${colClose(c)}`;
				const matched = `CASE WHEN ${negated} THEN ARRAY[]::text[] ELSE array_remove(
					ARRAY[${columns
						.map((c) => `CASE WHEN ${colHit(c)} THEN ${colLabel[c]}::text END`)
						.join(', ')}]::text[], NULL)
					|| ARRAY(
					     SELECT l.label
					       FROM unnest(${visibleKeys}::text[], ${labels}::text[]) WITH ORDINALITY AS l(k, label, n)
					      WHERE ${keyWhole} OR ${keySub} OR ${keyClose}
					      ORDER BY l.n
					   )
					|| ARRAY(
					     SELECT b.label
					       FROM unnest(${boxKeys}::text[], ${boxLabels}::text[]) WITH ORDINALITY AS b(k, label, n)
					      WHERE ${checked('b.k')} AND ${boxSub}
					      ORDER BY b.n
					   ) END`;
				// The name tier reads every visible source of the name: the joined
				// column when all its parts are visible, and the visible parts on
				// their own, so a private family name neither demotes a matching
				// given name nor lifts a member it alone would match.
				const nameWord = unlessNegated(
					any([
						...(columns.includes('name') ? [colWhole('name')] : []),
						keys(`l.k = ANY(${nameKeys}::text[]) AND ${keyWhole}`)
					])
				);
				return { block, matched, nameWord, wholeWord, substring, negated, filter };
			});
			// A negated word stands aside from the join: true under AND, and under
			// OR only when every word is negated, which leaves the filters to decide.
			and.push(
				join === 'AND'
					? `(${words.map((w) => `(${w.block} OR ${w.negated})`).join(' AND ')})`
					: `(${[...words.map((w) => w.block), `(${words.map((w) => w.negated).join(' AND ')})`].join(' OR ')})`
			);
			and.push(...words.map((w) => w.filter));
			// An ARRAY constructor, not jsonb_build_array: a function takes at most
			// 100 arguments, and a query may carry more words than that.
			matchedExpr = `to_jsonb(ARRAY[${words.map((w) => `to_jsonb(${w.matched})`).join(', ')}]::jsonb[])`;
			order = (['nameWord', 'wholeWord', 'substring'] as const).map(
				(k) => `${isTrue(words.map((w) => `(${w[k]})`).join(' OR '))} DESC`
			);
			// Ranking reads the whole query even when the blocks are OR'd: a row
			// that matched more of it outranks one that matched a single word.
			params.push(terms.join(' '));
			rankExpr = `ts_rank(visible_tsv, websearch_to_tsquery('simple', search_unaccent($${params.length})))`;
		}

		if (and.length) where.push(`(${and.join(' AND ')})`);

		params.push(RESULT_CAP);
		const { rows } = await query<MemberRow & { matched?: string[][] }>(
			`SELECT ${SELECT_COLS}, ${matchedExpr} AS matched
			   FROM ${from}
			  WHERE ${where.join(' AND ')}
			  ORDER BY ${[...order, `${rankExpr} DESC`, 'lower(name) NULLS LAST', 'lower(email)'].join(', ')}
			  LIMIT $${params.length}`,
			params
		);
		return rows.map((r) => ({ ...mapMember(r), matched: groupMatches(r.matched, typedTerms) }));
	};

	// Nothing to loosen unless there were several words to require at once: one
	// word AND'd and OR'd is the same query, and an empty result for it is the
	// honest answer.
	const pass = async (fuzzy: boolean) => {
		const members = await run('AND', fuzzy);
		if (members.length || terms.length < 2) return { members, relaxed: false };
		const any = await run('OR', fuzzy);
		return { members: any, relaxed: any.length > 0 };
	};

	const exact = await pass(false);
	if (exact.members.length || !terms.length || (!columns.length && !handle)) {
		return { ...exact, fuzzy: false };
	}
	const close = await pass(true);
	return { ...close, fuzzy: close.members.length > 0 };
}

// One entry per field label, carrying the query words that matched it, in the
// order the labels first appear.
function groupMatches(perWord: string[][] | undefined, terms: string[]): SearchMatch[] {
	const out: SearchMatch[] = [];
	(perWord ?? []).forEach((labels, i) => {
		for (const label of labels ?? []) {
			let m = out.find((x) => x.label === label);
			if (!m) out.push((m = { label, words: [] }));
			if (!m.words.includes(terms[i])) m.words.push(terms[i]);
		}
	});
	return out;
}
