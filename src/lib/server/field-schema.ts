// What a member field is. The list itself is the skin's `fields` key
// (skin.yaml, format in src/lib/skin/schema.ts); this module is how every
// reader of `member.data` and `member.private_data` reaches it, so a field
// renamed in the skin is renamed everywhere and a field missing there is
// missing everywhere, visibly.
//
// The schema sets the privacy boundary, which is why it is a reviewed file
// rather than a database column. `visibility: 'private'` decides the storage:
// such a field is written to `member.private_data`, which full-text search
// never reads, so a new private field is excluded from search by being declared
// private rather than by matching a word list.
//
// `key` is stable and is what both jsonb columns are keyed by. `label` is the
// form label and the CSV column header, one string for both.

import { currentSkin } from '../skin/load';
import {
	NO_TEXT_CONTROL_ROLES,
	type FIELD_ROLES,
	type OPTION_SETS,
	type PROMOTED_COLUMNS,
	type SkinField
} from '../skin/schema';

export type FieldType = SkinField['type'];
export type FieldVisibility = SkinField['visibility'];
export type FieldRole = (typeof FIELD_ROLES)[number];
export type PromotedColumn = (typeof PROMOTED_COLUMNS)[number];
export type OptionSet = (typeof OPTION_SETS)[number];

// A skin lists its fields in display order; `order` is that position, spaced
// so a synthesized definition can sort after every declared one.
export type FieldDef = SkinField & { order: number };

// The running skin's fields, and what every helper below reads when a caller
// passes no schema of its own.
export const DEFAULT_FIELD_SCHEMA: readonly FieldDef[] = Object.freeze(
	currentSkin().skin.fields.map((f, i): FieldDef => ({ ...f, order: (i + 1) * 10 }))
);

// A column the schema did not anticipate keeps its original header after
// `x.`. It is synthesized private: an unknown column could be anything, and
// the safe failure is an admin seeing it rather than search indexing it.
export const UNMAPPED_PREFIX = 'x.';
const UNMAPPED_ORDER = 100_000;

export function isUnmappedKey(key: string): boolean {
	return key.startsWith(UNMAPPED_PREFIX);
}

// The schema plus a synthesized definition for every `x.*` key in `keys`,
// ordered after every declared field and by key among themselves.
export function fieldsFor(
	keys: Iterable<string> = [],
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): FieldDef[] {
	const known = new Set(schema.map((f) => f.key));
	const extra = [...new Set(keys)]
		.filter((k) => isUnmappedKey(k) && !known.has(k))
		.sort()
		.map(
			(key, i): FieldDef => ({
				key,
				label: key.slice(UNMAPPED_PREFIX.length),
				type: 'text',
				visibility: 'private',
				order: UNMAPPED_ORDER + i
			})
		);
	return [...schema, ...extra].sort((a, b) => a.order - b.order);
}

export function fieldsWithRole(
	role: FieldRole,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): FieldDef[] {
	return schema.filter((f) => f.role === role).sort((a, b) => a.order - b.order);
}

// The one field holding a role a caller has already established is there.
export function fieldByRole(
	role: FieldRole,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): FieldDef {
	const hits = fieldsWithRole(role, schema);
	if (hits.length !== 1) {
		throw new Error(`the field schema needs exactly one "${role}" field, found ${hits.length}`);
	}
	return hits[0];
}

// The fields a member is named by, in schema order: one whole-name field, or
// a given and a family name. The loader has refused a skin with neither.
export function nameFields(schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA): FieldDef[] {
	return schema
		.filter((f) => f.role === 'name' || f.role === 'givenName' || f.role === 'familyName')
		.sort((a, b) => a.order - b.order);
}

// The field holding a role a skin may leave out, in which case the feature
// reading it is off. The loader has already refused a skin with two.
export function optionalFieldByRole(
	role: FieldRole,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): FieldDef | undefined {
	return fieldsWithRole(role, schema)[0];
}

const NOT_EDITABLE: ReadonlySet<FieldRole | undefined> = new Set(NO_TEXT_CONTROL_ROLES);

// Fields no profile form may write: the identity key, the avatar route's URL,
// the retired columns, and any unmapped `x.*` column.
export function isFormWritable(f: FieldDef): boolean {
	return !isUnmappedKey(f.key) && !['email', 'avatar', 'retired'].includes(f.role ?? '');
}

// The text fields the profile form edits, in schema order. Checkboxes and the
// free-text "Other" have their own controls; the address is the identity key
// and is not editable.
export function editableFields(schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA): FieldDef[] {
	return schema
		.filter((f) => f.type !== 'checkbox' && !NOT_EDITABLE.has(f.role) && !isUnmappedKey(f.key))
		.sort((a, b) => a.order - b.order);
}

export type MemberValues = Record<string, unknown>;

// The value a record holds under a field key, undefined when it holds none.
// A skin may key a field `toString` or `constructor`, and `record[key]` on an
// ordinary object answers those with the inherited function: an unanswered
// checkbox would read ticked and an empty text field would show source code.
// Every read of member values by field key goes through here.
export function ownValue<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

// Route each value to the column its field's visibility names. A key the
// schema does not know goes to private_data, by the rule `fieldsFor` applies.
export function splitData(
	values: MemberValues,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): { data: MemberValues; privateData: MemberValues } {
	const data: MemberValues = {};
	const privateData: MemberValues = {};
	for (const [k, v] of Object.entries(values)) {
		if (isMembersVisibleKey(k, schema)) data[k] = v;
		else privateData[k] = v;
	}
	return { data, privateData };
}

// True when a key is stored in member.data, which search reads.
export function isMembersVisibleKey(
	key: string,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): boolean {
	return schema.some((f) => f.key === key && f.visibility === 'members');
}

// The keys a member who is not a group admin may see on a profile, and so the
// only keys the directory search may match. The profile page and searchMembers
// both read visibility through here: search that decides for itself drifts from
// what the profile hides, and a count of matches reads a hidden value back out.
export function membersVisibleKeys(schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA): string[] {
	return schema.filter((f) => isMembersVisibleKey(f.key, schema)).map((f) => f.key);
}

// The fields the directory filters on by whole value: those the skin marks
// `filter: exact`, narrowed to membersVisibleKeys so a filter never reads a
// value the profile hides, whatever the skin says.
export function filterFields(schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA): FieldDef[] {
	const visible = new Set(membersVisibleKeys(schema));
	return schema.filter((f) => f.filter === 'exact' && visible.has(f.key));
}

const text = (v: unknown) => (v == null ? '' : String(v).trim());

// The member row's typed columns, each the non-empty values of the fields
// naming it, in schema order, joined with a space. A join is irreversible, so
// the parts stay stored as well.
export function promotedColumns(
	values: MemberValues,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): Record<PromotedColumn, string | null> {
	const join = (c: PromotedColumn) =>
		promotedKeys(c, schema)
			.map((k) => text(ownValue(values, k)))
			.filter(Boolean)
			.join(' ') || null;
	return {
		email: join('email'),
		name: join('name'),
		city: join('city'),
		linkedin: join('linkedin')
	};
}

// Where an exact filter reads a field's value: the promoted city column for the
// field that alone feeds it, and `data` at the field's own key for every other
// field. City is the one exception because the directory has always matched
// places on that column; a field feeding name, email or linkedin is still
// compared on its stored value, so a promoted column never answers for a key.
export function filterColumn(
	f: FieldDef,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): 'city' | undefined {
	if (f.column !== 'city') return undefined;
	const keys = promotedKeys('city', schema);
	return keys.length === 1 && keys[0] === f.key ? 'city' : undefined;
}

export function promotedKeys(
	column: PromotedColumn,
	schema: readonly FieldDef[] = DEFAULT_FIELD_SCHEMA
): string[] {
	return schema
		.filter((f) => f.column === column)
		.sort((a, b) => a.order - b.order)
		.map((f) => f.key);
}

// A checkbox reads back as "TRUE"/"FALSE" or a hand-typed marker. Checked
// unless empty or an explicit false/no/0.
export function isChecked(v: unknown): boolean {
	const s = text(v).toLowerCase();
	return s !== '' && s !== 'false' && s !== 'no' && s !== '0';
}

// What SQL counts as checked. Narrower than isChecked on purpose: a query that
// publishes someone (the public showcase) or matches them by affiliation reads
// only an explicit yes, never an unrecognized scribble.
export const CHECKED_SQL_VALUES = ['true', 'yes', 'y', 'x', '1', 'checked', 'on'] as const;
