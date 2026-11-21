// Test support: the field-schema module as it would be on a skin other than
// the running one. The suite runs on skin/default, which leaves most roles
// out; a test whose subject reads one of those roles hands `mock.module` these
// exports, so every module it then imports sees the fields given here, bound
// at load the way the running skin's are.
//
//   mock.module('$lib/server/field-schema', {
//     namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS)
//   });
//
// before the first import of anything that reads the schema.

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as real from './field-schema';
import { currentSkin, skinDir } from '../skin/load';
import { validateSkin, type SkinField } from '../skin/schema';
import type { FieldDef } from './field-schema';

// Which argument of each helper is the schema it defaults to the running
// skin's. An export of field-schema.ts in neither list is refused below, so a
// helper added there cannot quietly keep reading the default skin in a test
// that asked for another field set.
const SCHEMA_ARG = {
	fieldsFor: 1,
	fieldsWithRole: 1,
	fieldByRole: 1,
	nameFields: 0,
	optionalFieldByRole: 1,
	editableFields: 0,
	splitData: 1,
	isMembersVisibleKey: 1,
	membersVisibleKeys: 0,
	filterFields: 0,
	promotedColumns: 1,
	promotedKeys: 1,
	filterColumn: 1
} as const satisfies Partial<Record<keyof typeof real, number>>;

const SCHEMA_FREE: readonly (keyof typeof real)[] = [
	'UNMAPPED_PREFIX',
	'isUnmappedKey',
	'isFormWritable',
	'isChecked',
	'ownValue',
	'CHECKED_SQL_VALUES'
];

// `fields` goes through the skin validator first: a fixture the loader would
// refuse describes no skin a deployment can run.
//
// It runs on the shipped skin/default and nowhere else, selected and loaded.
// A test that points the process at another directory is running the
// application on a skin nobody ships, and a copy of the default that still
// says `id: default` is such a directory.
export function fieldSchemaWith(fields: readonly SkinField[]): typeof real {
	const shipped = realpathSync(fileURLToPath(new URL('../../../skin/default', import.meta.url)));
	for (const dir of [skinDir(), currentSkin().dir]) {
		if (realpathSync(dir) !== shipped) {
			throw new Error(
				`field-schema-fake runs on skin/default only; this process runs on ${dir}. ` +
					'Unset SKIN_DIR and pass the fields this test needs to fieldSchemaWith.'
			);
		}
	}
	validateSkin({ ...currentSkin().skin, fields }, 'field-schema-fake');
	const schema: readonly FieldDef[] = Object.freeze(
		fields.map((f, i): FieldDef => ({ ...f, order: (i + 1) * 10 }))
	);
	const out: Record<string, unknown> = { DEFAULT_FIELD_SCHEMA: schema };
	for (const name of SCHEMA_FREE) out[name] = real[name];
	for (const [name, at] of Object.entries(SCHEMA_ARG)) {
		const fn = real[name as keyof typeof SCHEMA_ARG] as (...args: unknown[]) => unknown;
		out[name] = (...args: unknown[]) => {
			const filled = [...args];
			// A value for an earlier optional argument, where the caller gave none.
			while (filled.length < at) filled.push(undefined);
			filled[at] ??= schema;
			return fn(...filled);
		};
	}
	const unbound = Object.keys(real).filter((name) => !(name in out));
	if (unbound.length) {
		throw new Error(`field-schema-fake does not say how to bind: ${unbound.join(', ')}`);
	}
	return out as typeof real;
}

// Every role, column and field type once, under neutral names no community
// uses.
export const EVERY_ROLE_FIELDS: readonly SkinField[] = [
	{
		key: 'givenName',
		label: 'Given name',
		type: 'text',
		visibility: 'members',
		role: 'givenName',
		column: 'name'
	},
	{
		key: 'familyName',
		label: 'Family name',
		type: 'text',
		visibility: 'members',
		role: 'familyName',
		column: 'name'
	},
	{
		key: 'email',
		label: 'Email',
		type: 'email',
		visibility: 'private',
		role: 'email',
		column: 'email'
	},
	{
		key: 'handle',
		label: 'Handle',
		type: 'text',
		visibility: 'members',
		role: 'handle',
		placeholder: 'e.g. ada'
	},
	{ key: 'bio', label: 'Bio', type: 'longtext', visibility: 'members', role: 'bio' },
	{ key: 'staff', label: 'Staff', type: 'checkbox', visibility: 'members', role: 'affiliation' },
	{
		key: 'volunteer',
		label: 'Volunteer',
		type: 'checkbox',
		visibility: 'members',
		role: 'affiliation'
	},
	{
		key: 'otherAffiliations',
		label: 'Other affiliations',
		type: 'text',
		visibility: 'members',
		role: 'affiliationOther'
	},
	{ key: 'country', label: 'Country', type: 'text', visibility: 'members' },
	{ key: 'city', label: 'City', type: 'text', visibility: 'members', column: 'city' },
	{
		key: 'startYear',
		label: 'Start year',
		type: 'year',
		visibility: 'members',
		role: 'tenureStart'
	},
	{ key: 'endYear', label: 'End year', type: 'year', visibility: 'members', role: 'tenureEnd' },
	{ key: 'interests', label: 'Interests', type: 'list', visibility: 'members' },
	{ key: 'website', label: 'Website', type: 'url', visibility: 'members', column: 'linkedin' },
	{
		key: 'publicProfile',
		label: 'Public profile',
		type: 'checkbox',
		visibility: 'members',
		role: 'publicProfile'
	},
	{ key: 'phone', label: 'Phone', type: 'text', visibility: 'private' },
	{ key: 'photo', label: 'Photo', type: 'url', visibility: 'private', role: 'avatar' },
	{
		key: 'legacyAccess',
		label: 'Legacy access',
		type: 'text',
		visibility: 'private',
		role: 'retired'
	}
];

// Every role, plus the private columns directory search was once able to read
// back: a garment size and a messaging checkbox, under labels that name
// neither "phone" nor "address".
export const PRIVATE_SEARCH_FIELDS: readonly SkinField[] = [
	...EVERY_ROLE_FIELDS,
	{ key: 'shirtSize', label: 'T-Shirt/Hoodie Size', type: 'text', visibility: 'private' },
	{ key: 'whatsapp', label: 'WhatsApp', type: 'checkbox', visibility: 'private' }
];

// Every role, plus a members-visible list and a private text field, so a
// search word can sit in a field the profile shows and in one it hides.
export const SEARCH_MATCH_FIELDS: readonly SkinField[] = [
	...EVERY_ROLE_FIELDS,
	{ key: 'hobbies', label: 'Hobbies', type: 'list', visibility: 'members' },
	{ key: 'pastime', label: 'Pastime', type: 'text', visibility: 'private' }
];

// The search fields, plus checkboxes whose labels carry accents, one
// members-visible and one private, so an accent fold is exercised on the
// label side as well as the query side.
export const UNICODE_SEARCH_FIELDS: readonly SkinField[] = [
	...SEARCH_MATCH_FIELDS,
	{ key: 'habitue', label: 'Café habitué', type: 'checkbox', visibility: 'members' },
	{ key: 'resident', label: 'Résident', type: 'checkbox', visibility: 'private' }
];

// Every name an ordinary object inherits that the skin's key pattern accepts,
// each keying a field, across the control kinds. A member who stored none of
// them must read as having stored none of them.
export const INHERITED_KEY_FIELDS: readonly SkinField[] = [
	{
		key: 'toString',
		label: 'Name',
		type: 'text',
		visibility: 'members',
		role: 'name',
		column: 'name'
	},
	{
		key: 'constructor',
		label: 'Public profile',
		type: 'checkbox',
		visibility: 'members',
		role: 'publicProfile'
	},
	{ key: 'valueOf', label: 'Staff', type: 'checkbox', visibility: 'members', role: 'affiliation' },
	{
		key: 'hasOwnProperty',
		label: 'Other affiliations',
		type: 'text',
		visibility: 'members',
		role: 'affiliationOther'
	},
	{ key: 'isPrototypeOf', label: 'Phone', type: 'text', visibility: 'private' },
	{
		key: 'propertyIsEnumerable',
		label: 'Website',
		type: 'url',
		visibility: 'members',
		column: 'linkedin'
	},
	{ key: 'toLocaleString', label: 'City', type: 'text', visibility: 'members', column: 'city' }
];

// The keys the profile editor once chose a control or a mandatory answer by.
export const HISTORICAL_CONTROL_KEYS = [
	'firstName',
	'country',
	'city',
	'linkedin',
	'startYear',
	'endYear',
	'sizeUnisex',
	'sizeMens',
	'sizeWomens',
	'cellCode'
] as const;

const plain = (key: string, extra: Partial<SkinField> = {}): SkinField => ({
	key,
	label: `Plain ${key}`,
	type: 'text',
	visibility: 'members',
	...extra
});

// Each of those keys on a field that declares no control (so each must be an
// optional free-text input), beside every option list and `required` on fields
// under keys the editor has never special-cased.
export const HISTORICAL_KEY_FIELDS: readonly SkinField[] = [
	plain('startYear', { role: 'name', column: 'name' }),
	...HISTORICAL_CONTROL_KEYS.filter((k) => k !== 'startYear' && k !== 'cellCode').map((k) =>
		plain(k)
	),
	plain('cellCode', { visibility: 'private' }),
	plain('homeland', { options: 'countries', required: true }),
	plain('settlement', { options: 'cities' }),
	plain('joined', { type: 'year', options: 'years', required: true }),
	plain('shirt', { visibility: 'private', options: 'sizes' }),
	plain('prefix', { visibility: 'private', options: 'dialingCodes' }),
	plain('motto', { required: true }),
	plain('story', { type: 'longtext', required: true }),
	plain('about', { type: 'longtext', role: 'bio', required: true }),
	plain('pager', { visibility: 'private', required: true }),
	plain('quiet', { required: false })
];

// Every role with country, city and both tenure years marked `filter: exact`,
// plus a members-visible place field that does not filter, so a directory
// parameter can name a filterable field, a visible one that is not, and a
// private one.
export const FILTER_SEARCH_FIELDS: readonly SkinField[] = [
	...EVERY_ROLE_FIELDS.map((f) =>
		['country', 'city', 'startYear', 'endYear'].includes(f.key)
			? { ...f, filter: 'exact' as const }
			: f
	),
	{ key: 'town', label: 'Other place', type: 'text', visibility: 'members' }
];
