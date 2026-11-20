// The roster import, pure: bytes to text, text to rows, rows to a diff against
// the roster, the diff to a digest, and the removal guard rails. No I/O, no
// SvelteKit, no $env, so the admin page and scripts/import-members.ts run the
// same decisions. member-import.ts owns the SQL.
//
// The file is the export's format read back (see member-export.ts), with three
// differences that make it safe to hand to a person with a spreadsheet:
//
//   • A column absent from the file leaves that field alone, and an empty cell
//     clears it. Nothing is inferred from absence, so a two-column file changes
//     one field.
//   • A heading that names no field is a warning and its values are dropped,
//     where readMemberCsv would turn it into a new `x.*` field. A typo in a
//     heading must not create a permanent column.
//   • Every row is checked before anything is applied. A blank, malformed or
//     repeated address makes the whole file invalid; no row is ever skipped.

import { createHash } from 'node:crypto';
import { BOM, parseCsvRecords, type CsvRecord, type Delimiter } from './csv-core';
import {
	DEFAULT_FIELD_SCHEMA,
	isMembersVisibleKey,
	isUnmappedKey,
	ownValue,
	type FieldDef
} from './field-schema';
import { LOGIN_KEY, STATUS_KEY, columnHeading, decodeCell, encodeCell } from './member-export';

export type ImportMode = 'merge' | 'replace';

export function importModeFrom(raw: unknown): ImportMode {
	return raw === 'replace' ? 'replace' : 'merge';
}

// Under the 6M BODY_SIZE_LIMIT in docker-compose.yml, so an oversized file
// gets this module's message rather than the adapter's bare 413. A roster of a
// few thousand members is well under a megabyte; UTF-16 doubles it.
export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
export const MAX_IMPORT_ROWS = 10_000;

export class ImportFileError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ImportFileError';
	}
}

// ---------------------------------------------------------------------------
// Bytes to text
// ---------------------------------------------------------------------------

// UTF-8 with or without a BOM, and UTF-16 either way round, which is what
// Excel's "Unicode Text" writes. A UTF-16 file without a BOM is recognized by
// the zero bytes ASCII leaves in every other position. Anything that is not
// valid UTF-8 is refused rather than read as a guessed code page, which would
// store mangled names without a word.
export function decodeUpload(bytes: Uint8Array): string {
	const b = bytes;
	if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return utf16(b.subarray(2), 'utf-16le');
	if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return utf16(b.subarray(2), 'utf-16be');
	const head = b.subarray(0, Math.min(b.length, 512));
	let zeroEven = 0;
	let zeroOdd = 0;
	head.forEach((x, i) => {
		if (x === 0) i % 2 === 0 ? zeroEven++ : zeroOdd++;
	});
	if (head.length >= 4 && zeroOdd > head.length / 4 && zeroEven === 0) {
		return utf16(b, 'utf-16le');
	}
	if (head.length >= 4 && zeroEven > head.length / 4 && zeroOdd === 0) {
		return utf16(b, 'utf-16be');
	}
	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(b);
		return text.startsWith(BOM) ? text.slice(BOM.length) : text;
	} catch {
		throw new ImportFileError(
			'The file is not UTF-8 text. In Excel use "Save As > CSV UTF-8"; in Numbers or Sheets, export as CSV.'
		);
	}
}

function utf16(b: Uint8Array, enc: 'utf-16le' | 'utf-16be'): string {
	if (b.length % 2 !== 0)
		throw new ImportFileError('The file is cut off part way through a character.');
	try {
		return new TextDecoder(enc, { fatal: true }).decode(b);
	} catch {
		throw new ImportFileError('The file looks like UTF-16 but does not decode as it.');
	}
}

// The separator the header record uses most, counted outside quotes. Field
// labels contain none of the three, so the header row decides it without
// reading member data. A file with a single column has none, and is comma.
export function sniffDelimiter(text: string): Delimiter {
	const counts: Record<Delimiter, number> = { ',': 0, ';': 0, '\t': 0 };
	let quoted = false;
	for (const ch of text) {
		if (ch === '"') quoted = !quoted;
		else if (!quoted && (ch === '\n' || ch === '\r')) break;
		else if (!quoted && ch in counts) counts[ch as Delimiter]++;
	}
	const order: Delimiter[] = [',', ';', '\t'];
	return order.reduce((best, d) => (counts[d] > counts[best] ? d : best), ',' as Delimiter);
}

// ---------------------------------------------------------------------------
// Text to rows
// ---------------------------------------------------------------------------

export type ImportRow = {
	// The spreadsheet's row number, header row 1, and the file line the row
	// starts on. They differ once a cell above holds a line break.
	row: number;
	line: number;
	email: string;
	// The Status column's value, when the file has one.
	status?: string;
	// Every recognized column but the address and Status. null is an empty
	// cell, which clears the field.
	values: Record<string, unknown>;
};

export type ParsedImport = {
	delimiter: Delimiter;
	// The field keys the file carries, in file order, Status included.
	keys: string[];
	rows: ImportRow[];
	errors: string[];
	warnings: string[];
};

// Where to look, in the words a spreadsheet uses, with the file line beside it
// when the two differ so a text editor finds it too.
export function rowRef(r: { row: number; line: number }): string {
	return r.row === r.line ? `row ${r.row}` : `row ${r.row} (file line ${r.line})`;
}

const norm = (h: string) => h.trim().toLowerCase();

// The address check approval and sign-in already rely on in practice: one @,
// something either side, a dot in the domain, no whitespace.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const STATUS_VALUES = ['active', 'removed'] as const;

// Every heading the file may use, keyed by its normalized text. A declared
// field answers to its label and nothing else. An `x.*` column answers to the
// heading the export gives it and to its full key, and only when the roster
// already holds that key: the file never adds a column.
function headingIndex(schema: readonly FieldDef[], storedKeys: Iterable<string>) {
	const index = new Map<string, string>();
	const add = (heading: string, key: string) => index.set(norm(heading), key);
	add(columnHeading(LOGIN_KEY, schema), LOGIN_KEY);
	add(columnHeading(STATUS_KEY, schema), STATUS_KEY);
	for (const f of schema) add(columnHeading(f.key, schema), f.key);
	for (const k of storedKeys) {
		if (!isUnmappedKey(k) || schema.some((f) => f.key === k)) continue;
		add(k, k);
		add(columnHeading(k, schema), k);
	}
	return index;
}

export function parseImport(
	text: string,
	opts: {
		mode: ImportMode;
		storedKeys?: Iterable<string>;
		schema?: readonly FieldDef[];
		maxRows?: number;
	}
): ParsedImport {
	const schema = opts.schema ?? DEFAULT_FIELD_SCHEMA;
	const maxRows = opts.maxRows ?? MAX_IMPORT_ROWS;
	const delimiter = sniffDelimiter(text);
	const out: ParsedImport = { delimiter, keys: [], rows: [], errors: [], warnings: [] };

	let records: CsvRecord[];
	try {
		records = parseCsvRecords(text, delimiter);
	} catch (e) {
		out.errors.push(`The file could not be read: ${(e as Error).message}.`);
		return out;
	}
	const [header, ...body] = records;
	if (!header || header.cells.every((c) => c.trim() === '')) {
		// Nothing to match on. The caller decides whether an empty file is a
		// refusal, which it is against a populated group.
		return out;
	}

	const index = headingIndex(schema, opts.storedKeys ?? []);
	const loginLabel = columnHeading(LOGIN_KEY, schema);
	const columns: (string | null)[] = [];
	const seen = new Map<string, number>();
	header.cells.forEach((cell, i) => {
		const key = index.get(norm(cell)) ?? null;
		columns.push(key);
		const col = i + 1;
		if (key === null) {
			// A spreadsheet that saved a trailing separator leaves an empty,
			// unheaded column behind. Only one with something in it is news.
			const blank = cell.trim() === '';
			if (blank && body.every((r) => (r.cells[i] ?? '').trim() === '')) return;
			const shown = blank ? `Column ${col} (no heading)` : `"${cell.trim()}"`;
			out.warnings.push(
				`${shown} is not a field this community has, so its values are not saved. Check the heading against an export.`
			);
			return;
		}
		const first = seen.get(key);
		if (first !== undefined) {
			out.errors.push(
				`Columns ${first} and ${col} both read as "${columnHeading(key, schema)}". Delete one of them.`
			);
		} else seen.set(key, col);
	});
	if (!seen.has(LOGIN_KEY)) {
		out.errors.push(
			`The file has no "${loginLabel}" column. Every row is matched to a member by it.`
		);
	}
	if (seen.has(STATUS_KEY) && opts.mode === 'merge') {
		out.warnings.push(
			'Merge never removes anyone or changes who is active, so the Status column is ignored. Use Replace for that.'
		);
	}
	out.keys = [...seen.keys()].filter((k) => k !== LOGIN_KEY);
	if (out.errors.length) return out;

	const width = header.cells.length;
	const byEmail = new Map<string, ImportRow>();
	const badEmail: string[] = [];
	const blankEmail: string[] = [];
	body.forEach((rec, i) => {
		const pos = { row: i + 2, line: rec.line };
		// Only an empty line in a file of several columns is formatting: a
		// spreadsheet writes a separator for every cell of every row, so a member
		// row there is never empty. With one column, an empty line is exactly what
		// a blanked Email cell saves as, so it is checked like any other row.
		if (rec.empty && width > 1) return;
		if (rec.cells.length > width && rec.cells.slice(width).some((c) => c.trim() !== '')) {
			out.errors.push(
				`${rowRef(pos)} has more cells than there are headings. A value may have slipped into the next column.`
			);
			return;
		}
		if (rec.cells.length < width) {
			out.errors.push(
				`${rowRef(pos)} has ${rec.cells.length} cells but the heading row has ${width}. The row may be cut off.`
			);
			return;
		}
		const row: ImportRow = { ...pos, email: '', values: {} };
		try {
			columns.forEach((key, c) => {
				if (key === null) return;
				const cell = rec.cells[c];
				if (key === LOGIN_KEY) row.email = cell.trim();
				else if (key === STATUS_KEY) row.status = cell.trim().toLowerCase();
				else row.values[key] = cell.trim() === '' ? null : decodeCell(cell);
			});
		} catch (e) {
			out.errors.push(`${rowRef(pos)}: ${(e as Error).message}.`);
			return;
		}
		if (row.email === '') {
			blankEmail.push(rowRef(pos));
			return;
		}
		if (!EMAIL.test(row.email)) {
			badEmail.push(`${rowRef(pos)} ("${row.email}")`);
			return;
		}
		if (row.status !== undefined && !(STATUS_VALUES as readonly string[]).includes(row.status)) {
			out.errors.push(
				`${rowRef(pos)}: Status must be ${STATUS_VALUES.join(' or ')}, not "${row.status}".`
			);
			return;
		}
		const dup = byEmail.get(row.email.toLowerCase());
		if (dup) {
			out.errors.push(
				`${row.email} appears twice, on ${rowRef(dup)} and ${rowRef(pos)}. Keep one of them.`
			);
			return;
		}
		byEmail.set(row.email.toLowerCase(), row);
		out.rows.push(row);
	});
	if (blankEmail.length) {
		out.errors.push(
			`${plural(blankEmail.length, 'row has', 'rows have')} no ${loginLabel}: ${blankEmail.join(', ')}. Nothing is imported until every row has one, so no member is dropped without a word.`
		);
	}
	if (badEmail.length) {
		out.errors.push(`Not an email address: ${badEmail.join(', ')}.`);
	}
	if (out.rows.length > maxRows) {
		out.errors.push(
			`The file has ${out.rows.length} rows; the import takes at most ${maxRows}. Split it, or use scripts/import-members.ts.`
		);
	}
	return out;
}

function plural(n: number, one: string, many: string): string {
	return `${n} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Rows to a diff
// ---------------------------------------------------------------------------

export type RosterMember = {
	id: string;
	email: string;
	status: string;
	data: Record<string, unknown>;
	privateData: Record<string, unknown>;
};

export type FieldChange = { key: string; before: unknown; after: unknown };

export type ImportDiff = {
	mode: ImportMode;
	rows: number;
	// Active members before the import: what the removal guard measures against.
	active: number;
	added: { email: string; row: ImportRow; values: Record<string, unknown> }[];
	changed: {
		id: string;
		email: string;
		// The member's status before the import, so a row that edits a removed
		// member says so.
		status: string;
		row: ImportRow;
		changes: FieldChange[];
	}[];
	removed: { id: string; email: string; via: 'absent' | 'status' }[];
	unchanged: number;
	errors: string[];
};

declare global {
	interface JSON {
		isRawJSON(v: unknown): boolean;
	}
}

// What a cell and a stored value are compared as. Surrounding whitespace is not
// a change, a stored empty string and a missing key are the same state (as the
// export writes them), and anything structured compares by its JSON with object
// keys sorted at every depth. jsonb reorders keys on storage, so without the
// sort a value read back from PostgreSQL (the roster, a stored plan) never
// equals the same value as the file spelled it. Numbers stay JSON.rawJSON and
// print their own digits.
export function canonical(v: unknown): string {
	if (v === undefined || v === null) return '';
	if (typeof v === 'string') return v.trim();
	return JSON.stringify(sortedKeys(v));
}

// What equality and the digest see: canonical's equivalences, but typed. A
// string is its trimmed JSON literal, so text "true" or "42" never matches the
// boolean or number the preview shows as json:true or json:42, and only an
// empty value maps to ''.
export function comparable(v: unknown): string {
	const text = canonical(v);
	if (text === '') return '';
	return typeof v === 'string' ? JSON.stringify(text) : text;
}

function sortedKeys(v: unknown): unknown {
	if (v === null || typeof v !== 'object' || JSON.isRawJSON(v)) return v;
	if (Array.isArray(v)) return v.map(sortedKeys);
	const o = v as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(o)
			.sort()
			.map((k) => [k, sortedKeys(o[k])])
	);
}

export function storedValue(m: RosterMember, key: string): unknown {
	return Object.hasOwn(m.data, key) ? m.data[key] : ownValue(m.privateData, key);
}

// Merge reads only the rows in the file, never touches status, and has no
// removal branch at all. Replace treats the file as the roster: a row is an
// active member unless its Status cell says removed, and every active member
// whose address is not in the file is removed. That set difference is the only
// removal, and nothing about it depends on when anything ran.
export function diffImport(
	parsed: Pick<ParsedImport, 'rows' | 'keys'>,
	roster: readonly RosterMember[],
	mode: ImportMode
): ImportDiff {
	const diff: ImportDiff = {
		mode,
		rows: parsed.rows.length,
		active: roster.filter((m) => m.status === 'active').length,
		added: [],
		changed: [],
		removed: [],
		unchanged: 0,
		errors: []
	};
	const byEmail = new Map(roster.map((m) => [m.email.toLowerCase(), m]));
	const inFile = new Set<string>();

	for (const row of parsed.rows) {
		const email = row.email.toLowerCase();
		inFile.add(email);
		const m = byEmail.get(email);
		const status = mode === 'replace' ? (row.status ?? 'active') : undefined;
		if (!m) {
			if (status !== undefined && status !== 'active') {
				diff.errors.push(
					`${rowRef(row)}: ${row.email} is not in the directory, so it cannot be marked ${status}. Delete the row or set Status to active.`
				);
				continue;
			}
			const values = Object.fromEntries(
				Object.entries(row.values).filter(([, v]) => comparable(v) !== '')
			);
			diff.added.push({ email: row.email, row, values });
			continue;
		}
		const changes: FieldChange[] = [];
		for (const [key, after] of Object.entries(row.values)) {
			const before = storedValue(m, key);
			if (comparable(before) !== comparable(after)) changes.push({ key, before, after });
		}
		if (status !== undefined && status !== m.status) {
			if (status === 'removed' && m.status === 'active') {
				diff.removed.push({ id: m.id, email: m.email, via: 'status' });
			} else {
				changes.push({ key: STATUS_KEY, before: m.status, after: status });
			}
		}
		if (changes.length) {
			diff.changed.push({ id: m.id, email: m.email, status: m.status, row, changes });
		} else if (!diff.removed.some((r) => r.id === m.id)) diff.unchanged++;
	}

	if (mode === 'replace') {
		for (const m of roster) {
			if (m.status === 'active' && !inFile.has(m.email.toLowerCase())) {
				diff.removed.push({ id: m.id, email: m.email, via: 'absent' });
			}
		}
	}
	return diff;
}

// What the admin is shown, hashed. Apply recomputes the diff against the roster
// as it stands under the lock and refuses unless this matches the digest that
// was on screen, so the change applied is the change that was read.
export function diffDigest(diff: ImportDiff): string {
	const byEmail = <T extends { email: string }>(xs: T[]) =>
		[...xs].sort((a, b) => a.email.toLowerCase().localeCompare(b.email.toLowerCase()));
	const sortedEntries = (o: Record<string, unknown>) =>
		Object.keys(o)
			.sort()
			.map((k) => [k, comparable(o[k])]);
	const body = {
		mode: diff.mode,
		active: diff.active,
		rows: diff.rows,
		added: byEmail(diff.added).map((a) => [a.email.toLowerCase(), sortedEntries(a.values)]),
		// Status is the membership state the preview explains each edit against
		// ("removed member, stays removed"); without it two imports that swap who is
		// active leave every count and value equal while the explanation reverses.
		changed: byEmail(diff.changed).map((c) => [
			c.email.toLowerCase(),
			c.status,
			[...c.changes]
				.sort((a, b) => a.key.localeCompare(b.key))
				.map((x) => [x.key, comparable(x.before), comparable(x.after)])
		]),
		removed: byEmail(diff.removed).map((r) => [r.email.toLowerCase(), r.via]),
		unchanged: diff.unchanged
	};
	return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

// ---------------------------------------------------------------------------
// Removal guard rails
// ---------------------------------------------------------------------------

export const DEFAULT_CONFIRM_PERCENT = 10;

// IMPORT_CONFIRM_REMOVALS_PERCENT: removals above this share of the active
// roster need the count typed. Past half the roster the UI refuses whatever it
// is set to, so a value above 50 would change nothing and is refused as a typo.
export function confirmPercentFrom(env: Record<string, string | undefined>): number {
	const raw = env.IMPORT_CONFIRM_REMOVALS_PERCENT;
	if (raw == null || raw.trim() === '') return DEFAULT_CONFIRM_PERCENT;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 0 || n > 50) {
		throw new Error(
			`IMPORT_CONFIRM_REMOVALS_PERCENT must be a whole number from 0 to 50; got "${raw}"`
		);
	}
	return n;
}

export type RemovalGate =
	| { kind: 'none' }
	| { kind: 'proceed' }
	| { kind: 'typed'; count: number }
	| { kind: 'refused'; reason: 'empty-file' | 'over-half'; message: string };

// Escalating, and measured against the active roster before the import:
//   no removals          nothing to confirm
//   up to confirmPercent the Apply button is the confirmation
//   up to half           the count has to be typed
//   past half            refused in the browser; scripts/import-members.ts only
// Separately, a file with no member rows against a populated group is refused
// in every mode and every channel: it is what a truncated or misdirected file
// looks like, and no roster edit needs it.
export function removalGate(
	diff: Pick<ImportDiff, 'rows' | 'active' | 'removed'>,
	confirmPercent: number,
	slug = '<slug>'
): RemovalGate {
	if (diff.rows === 0 && diff.active > 0) {
		return {
			kind: 'refused',
			reason: 'empty-file',
			message: `The file has no member rows, and this community has ${diff.active} active members. A file like that is almost always cut off or the wrong file, so it is never applied.`
		};
	}
	const n = diff.removed.length;
	if (n === 0) return { kind: 'none' };
	if (n * 2 > diff.active) {
		return {
			kind: 'refused',
			reason: 'over-half',
			message: `This would remove ${n} of ${diff.active} active members, more than half the directory. That is not done from the browser. If it is really intended, an operator can run: deploy/run.sh import-members ${slug} - --replace --apply --confirm-removals ${n} < roster.csv`
		};
	}
	if (n * 100 > confirmPercent * diff.active) return { kind: 'typed', count: n };
	return { kind: 'proceed' };
}

// Whether the confirmation the admin gave satisfies the gate.
export function gateSatisfied(gate: RemovalGate, typed: string | null | undefined): boolean {
	if (gate.kind === 'refused') return false;
	if (gate.kind === 'typed') return (typed ?? '').trim() === String(gate.count);
	return true;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

// A field is private here exactly when splitData stores it privately, so the
// per-member rows record that a private value changed and never the value.
export function isPrivateKey(key: string, schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA) {
	return key !== STATUS_KEY && !isMembersVisibleKey(key, schema);
}

// ---------------------------------------------------------------------------
// The preview screen
// ---------------------------------------------------------------------------

export type PreviewView = {
	mode: ImportMode;
	rows: number;
	active: number;
	counts: { added: number; changed: number; removed: number; unchanged: number };
	added: { email: string; at: string; fields: { label: string; value: string }[] }[];
	changed: {
		email: string;
		at: string;
		// The row edits a member who is not active, which merge leaves that way.
		inactive: boolean;
		fields: { label: string; before: string; after: string }[];
	}[];
	removed: { email: string; why: string }[];
};

// Strings only, in the export's cell format, so the page shows what the file
// would show and nothing structured reaches the browser.
function shown(v: unknown): string {
	return v === null || v === undefined ? '' : encodeCell(v);
}

export function previewView(
	diff: ImportDiff,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): PreviewView {
	const label = (key: string) => columnHeading(key, schema);
	return {
		mode: diff.mode,
		rows: diff.rows,
		active: diff.active,
		counts: {
			added: diff.added.length,
			changed: diff.changed.length,
			removed: diff.removed.length,
			unchanged: diff.unchanged
		},
		added: diff.added.map((a) => ({
			email: a.email,
			at: rowRef(a.row),
			fields: Object.entries(a.values).map(([k, v]) => ({ label: label(k), value: shown(v) }))
		})),
		changed: diff.changed.map((c) => ({
			email: c.email,
			at: rowRef(c.row),
			inactive: c.status !== 'active' && !c.changes.some((x) => x.key === STATUS_KEY),
			fields: c.changes.map((x) => ({
				label: label(x.key),
				before: shown(x.before),
				after: shown(x.after)
			}))
		})),
		removed: diff.removed.map((r) => ({
			email: r.email,
			why: r.via === 'status' ? 'Status says removed' : 'not in the file'
		}))
	};
}
