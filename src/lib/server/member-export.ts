// The roster as a CSV, for the admin endpoint and scripts/export-members.ts.
// No SvelteKit or $env imports, so the script runs the same code over its own
// pool, and the import (import-core.ts) reads headings and cells back with
// columnHeading and decodeCell from here.
// The caller owns the transaction and the audit row.
//
// The round-trip contract: importing an unmodified full export (private and
// removed both included) produces a zero-row diff. So every column heading
// names exactly one stored key, every stored value lands in a cell, and the
// file plus the field schema are enough to get both back: columnKey inverts
// columnHeading, and decodeCell inverts encodeCell, without the roster that
// produced the file. An empty cell and an absent key are the same state, since
// a spreadsheet cannot tell them apart. A narrower variant is a subset of the
// full one and promises the same for the columns it carries.
//
// The sign-in address and the stored Email field are two values, not one:
// migration 13 kept the sheet's Email cell even where a group signed in by
// another column, and an object stored there is not an address at all. So the
// Email column is member.email, the identity an import matches on, and a
// private export adds `Email (stored)` beside it carrying the field as stored.
// Neither is inferred from the other on the way back in.

import { formatCsv, parseCsv } from './csv-core';
import { LOGIN_LABEL } from '../skin/schema';
import { linksText, storedLinks } from '../links';
import {
	DEFAULT_FIELD_SCHEMA,
	UNMAPPED_PREFIX,
	fieldsFor,
	isUnmappedKey,
	ownValue,
	type FieldDef
} from './field-schema';

export type ExportOptions = {
	// Adds every private field, `x.*` columns included.
	includePrivate: boolean;
	// Adds members whose status is not 'active', and a Status column.
	includeRemoved: boolean;
};

export type ExportMember = {
	email: string;
	status: string;
	data: Record<string, unknown>;
	privateData: Record<string, unknown>;
};

export type ExportColumn = {
	heading: string;
	// The field key, or STATUS_KEY for the Status column.
	key: string;
	read: (m: ExportMember) => unknown;
};

export const STATUS_LABEL = 'Status';
export const STATUS_KEY = 'status';
// The key the Email column decodes to. It is not a field key: the email-role
// field's own key names the stored value, in the STORED_SUFFIX column.
export const LOGIN_KEY = 'login';
export const STORED_SUFFIX = ' (stored)';

// A cell holding anything but a string is written as JSON after this marker,
// so an object keeps its content and a list keeps its element boundaries. A
// string that itself starts with the marker is written the same way, as a JSON
// string, so no member's text can be read back as a structured value.
export const JSON_CELL_PREFIX = 'json:';

// Every JSON number on this path is held as JSON.rawJSON of its source digits,
// never as a JS number: PostgreSQL keeps 9007199254740993 and 1e400 exactly,
// and a double would turn the first into ...992 and the second into null. So
// the loader reads jsonb as text and parses it here rather than through the
// driver's JSON.parse, and JSON.stringify writes the raw digits back out. A
// decoded value goes back into PostgreSQL the same way, through JSON.stringify.
declare global {
	// Node 22 ships it (TC39 JSON.parse source text access); TypeScript's lib
	// does not declare it yet.
	interface JSON {
		rawJSON(text: string): object;
	}
}

export function parseJsonExact(text: string): unknown {
	return JSON.parse(text, (_k, v, ctx?: { source?: string }) =>
		typeof v === 'number' ? JSON.rawJSON(ctx!.source!) : v
	);
}

export function encodeCell(v: unknown): string {
	if (v === undefined) return '';
	if (typeof v === 'string' && !v.startsWith(JSON_CELL_PREFIX)) return v;
	return JSON_CELL_PREFIX + JSON.stringify(v);
}

export function decodeCell(cell: string): unknown {
	if (!cell.startsWith(JSON_CELL_PREFIX)) return cell;
	try {
		return parseJsonExact(cell.slice(JSON_CELL_PREFIX.length));
	} catch {
		throw new Error(`a cell starting "${JSON_CELL_PREFIX}" does not hold valid JSON`);
	}
}

// Headings, encoded so each one names one key and is decoded from the schema
// alone. A declared field is headed by its label and the Status column by
// STATUS_LABEL. An `x.<header>` key is headed by its original header text when
// that text cannot be mistaken for another heading, and by its full key
// otherwise: when the text repeats a reserved heading, starts with `x.`
// itself, or is blank or padded. Comparison ignores case and surrounding
// spaces, so an import that normalizes headings still lands on the same key.
const norm = (h: string) => h.trim().toLowerCase();

function headingRules(schema: readonly FieldDef[]) {
	const declared = new Set(schema.map((f) => f.key));
	for (const key of [STATUS_KEY, LOGIN_KEY]) {
		if (declared.has(key)) {
			throw new Error(`the field schema declares "${key}", a key the export reserves`);
		}
	}
	const email = schema.find((f) => f.role === 'email');
	const login = email?.label ?? LOGIN_LABEL;
	const stored = email && email.label + STORED_SUFFIX;
	// Without an email-role field the login heading is no field's label, so it
	// is reserved here; with one, the label loop below reserves it.
	const reserved = new Set([norm(STATUS_LABEL), ...(email ? [] : [norm(login)])]);
	for (const label of [...schema.map((f) => f.label), ...(stored ? [stored] : [])]) {
		if (norm(label).startsWith(UNMAPPED_PREFIX) || reserved.has(norm(label))) {
			throw new Error(`the field label "${label}" cannot be told apart from another heading`);
		}
		reserved.add(norm(label));
	}
	return { reserved, email, login, stored };
}

export function columnHeading(
	key: string,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): string {
	const { reserved, email, login, stored } = headingRules(schema);
	if (key === STATUS_KEY) return STATUS_LABEL;
	if (key === LOGIN_KEY) return login;
	if (key === email?.key) return stored!;
	const field = schema.find((f) => f.key === key);
	if (field) return field.label;
	if (!isUnmappedKey(key)) {
		throw new Error(
			`"${key}" is neither a schema field nor an ${UNMAPPED_PREFIX}* column, so the export cannot name it; rename it to "${UNMAPPED_PREFIX}${key}"`
		);
	}
	const text = key.slice(UNMAPPED_PREFIX.length);
	const bare =
		text !== '' &&
		text === text.trim() &&
		!reserved.has(norm(text)) &&
		!norm(text).startsWith(UNMAPPED_PREFIX);
	return bare ? text : key;
}

// The inverse of columnHeading. A heading the file did not get from the export
// (a column an admin added) becomes `x.<heading>`, the rule migration 13
// applied to sheet columns the schema did not know.
export function columnKey(
	heading: string,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): string {
	const { email, login, stored } = headingRules(schema);
	if (heading === STATUS_LABEL) return STATUS_KEY;
	if (heading === login) return LOGIN_KEY;
	if (email && heading === stored) return email.key;
	const field = schema.find((f) => f.label === heading);
	if (field) return field.key;
	return heading.startsWith(UNMAPPED_PREFIX) ? heading : UNMAPPED_PREFIX + heading;
}

// The schema's labels in the schema's order, which is what makes the file open
// in Excel looking like the sheet the community knows. The email-role field's
// label heads member.email in every variant although the field is private: it
// is the identity an import keys on. The field's stored value follows it in a
// private variant only, as every other private field does.
export function exportColumns(
	members: readonly ExportMember[],
	opts: ExportOptions,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): ExportColumn[] {
	const stored = opts.includePrivate
		? [...new Set(members.flatMap((m) => [...Object.keys(m.data), ...Object.keys(m.privateData)]))]
		: [];
	// fieldsFor drops a key that is neither declared nor x.*. The full export
	// asks columnHeading for each one instead, which refuses it by name rather
	// than leave a stored value out of the file.
	for (const k of stored) columnHeading(k, schema);
	const fields = fieldsFor(stored, schema).filter(
		(f) => f.role === 'email' || f.visibility === 'members' || opts.includePrivate
	);

	const column = (f: FieldDef): ExportColumn => {
		const read =
			f.visibility === 'members'
				? (m: ExportMember) => ownValue(m.data, f.key)
				: // An x.* key is private by default but migration 13 placed two of
					// them in data, so a private field reads whichever bag holds it.
					(m: ExportMember) =>
						Object.hasOwn(m.privateData, f.key) ? m.privateData[f.key] : ownValue(m.data, f.key);
		return {
			heading: columnHeading(f.key, schema),
			key: f.key,
			// A links list is one cell of `site:handle` pairs, which a person can
			// edit in a spreadsheet and the import reads back.
			read: f.type === 'links' ? (m) => linksText(storedLinks(read(m))) || undefined : read
		};
	};
	const login: ExportColumn = {
		heading: columnHeading(LOGIN_KEY, schema),
		key: LOGIN_KEY,
		read: (m) => m.email
	};
	// The sign-in address sits where the email-role field does, and leads the
	// file where the skin has no such field: an import cannot key a row
	// without it, so no variant and no skin leaves it out.
	const columns: ExportColumn[] = [
		...(fields.some((f) => f.role === 'email') ? [] : [login]),
		...fields.flatMap((f) =>
			f.role !== 'email' ? [column(f)] : [login, ...(opts.includePrivate ? [column(f)] : [])]
		)
	];
	if (opts.includeRemoved) {
		columns.push({ heading: STATUS_LABEL, key: STATUS_KEY, read: (m) => m.status });
	}

	const headings = columns.map((c) => c.heading);
	const dup = headings.find((h, i) => headings.indexOf(h) !== i);
	if (dup !== undefined) throw new Error(`two export columns share the heading "${dup}"`);
	return columns;
}

export function memberCsv(
	members: readonly ExportMember[],
	opts: ExportOptions,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): string {
	const columns = exportColumns(members, opts, schema);
	return formatCsv([
		columns.map((c) => c.heading),
		...members.map((m) => columns.map((c) => encodeCell(c.read(m))))
	]);
}

export type ImportedMember = {
	// member.email as the file states it, from the Email column.
	email: string;
	// The Status column's value, or undefined in a file without one.
	status: unknown;
	// Every other non-empty cell under its field key, the email-role field's own
	// key included when the file has the stored column.
	values: Record<string, unknown>;
};

// A decoder from the file and the schema alone: the inverse of memberCsv for
// every column the file carries. The admin import does not use it, because it
// turns an unknown heading into a new `x.*` field, which an upload must never
// do; it is the round-trip contract stated as code. The login and the stored Email
// field come back separately, and neither fills in for the other when absent.
export function readMemberCsv(
	text: string,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): ImportedMember[] {
	const [head = [], ...body] = parseCsv(text);
	const keys = head.map((h) => columnKey(h, schema));
	const dup = keys.find((k, i) => keys.indexOf(k) !== i);
	if (dup !== undefined) throw new Error(`two columns decode to the key "${dup}"`);
	const login = keys.indexOf(LOGIN_KEY);
	if (login < 0) throw new Error(`the file has no ${columnHeading(LOGIN_KEY, schema)} column`);
	return body.map((cells, row) => {
		const email = decodeCell(cells[login] ?? '');
		if (typeof email !== 'string' || email === '') {
			throw new Error(`row ${row + 2} has no sign-in address`);
		}
		const out: ImportedMember = { email, status: undefined, values: {} };
		cells.forEach((c, i) => {
			if (keys[i] === LOGIN_KEY) return;
			if (keys[i] === STATUS_KEY) out.status = decodeCell(c);
			else if (c !== '') out.values[keys[i]] = decodeCell(c);
		});
		return out;
	});
}

// The variant is in the name so a private file is never mistaken for the
// shareable one once it is sitting in a downloads folder.
export function exportFilename(slug: string, opts: ExportOptions, now: Date): string {
	const parts = [slug.replace(/[^a-z0-9-]/gi, '_'), 'members'];
	if (opts.includePrivate) parts.push('PRIVATE');
	if (opts.includeRemoved) parts.push('with-removed');
	parts.push(now.toISOString().slice(0, 10));
	return `${parts.join('-')}.csv`;
}

// Only the literal "1" turns a variant on. Anything else yields the narrower
// file, which is the safe direction to be wrong in.
export function exportOptionsFrom(params: URLSearchParams): ExportOptions {
	return {
		includePrivate: params.get('private') === '1',
		includeRemoved: params.get('removed') === '1'
	};
}

type Queryable = {
	query<R>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
};

// private_data is not selected for a variant that does not print it, so no
// code path between here and the response can leak it. Both bags arrive as
// text for parseJsonExact; the driver's own jsonb parser rounds numbers.
export async function loadExportMembers(
	db: Queryable,
	groupId: string,
	opts: ExportOptions
): Promise<ExportMember[]> {
	const { rows } = await db.query<{
		email: string;
		status: string;
		data: string | null;
		private_data: string | null;
	}>(
		`SELECT email, status, data::text AS data,
		        ${opts.includePrivate ? 'private_data::text AS private_data' : `'{}' AS private_data`}
		   FROM member
		  WHERE group_id = $1 ${opts.includeRemoved ? '' : `AND status = 'active'`}
		  ORDER BY lower(email), email`,
		[groupId]
	);
	return rows.map((r) => ({
		email: r.email,
		status: r.status,
		data: r.data === null ? {} : (parseJsonExact(r.data) as Record<string, unknown>),
		privateData:
			r.private_data === null ? {} : (parseJsonExact(r.private_data) as Record<string, unknown>)
	}));
}

// The audit row a private export writes. Without private fields there is no
// row: the file carries addresses but no value the directory does not already
// show every admin.
export function exportAuditEntry(
	group: { id: string; slug: string },
	opts: ExportOptions,
	rows: number,
	actor: { actorSubject: string | null; actorEmail: string | null }
) {
	return {
		category: 'data' as const,
		action: 'members.export-private',
		...actor,
		groupId: group.id,
		groupSlug: group.slug,
		meta: { privateFields: true, includeRemoved: opts.includeRemoved, rows }
	};
}
