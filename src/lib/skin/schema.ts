// The skin.yaml format, declared once. `SKIN_SCHEMA` is the only definition:
// the `Skin` type is inferred from it, `validateSkin` walks it, and
// `describeSkinSchema` lists it for the test that holds docs/skin.md to it.
//
// From v0.1.0 this format is public interface. A key added here is optional
// and a key is never renamed or removed outside a major release; the test over
// src/lib/skin/released is what notices.

import { parse } from 'yaml';
import { ANALYTICS_PROVIDERS } from './analytics.js';

type StringNode = { kind: 'string'; pattern?: RegExp; expect?: string };
type VersionNode = { kind: 'version' };
type BooleanNode = { kind: 'boolean' };
type EnumNode<V extends string = string> = { kind: 'enum'; values: readonly V[] };
// Interfaces, because the two recursive nodes cannot be type aliases.
interface ListNode<N extends Node = Node> {
	kind: 'list';
	of: N;
}
interface ObjectNode<K extends Record<string, Entry> = Record<string, Entry>> {
	kind: 'object';
	keys: K;
}
type Node = StringNode | VersionNode | BooleanNode | EnumNode | ListNode | ObjectNode;
type Entry = Node & { optional?: true };

type Flat<T> = { [P in keyof T]: T[P] } & {};
type Infer<N> = N extends StringNode
	? string
	: N extends VersionNode
		? number
		: N extends BooleanNode
			? boolean
			: N extends EnumNode<infer V>
				? V
				: N extends ListNode<infer O>
					? Infer<O>[]
					: N extends ObjectNode<infer K>
						? Flat<
								{ [P in keyof K as K[P] extends { optional: true } ? never : P]: Infer<K[P]> } & {
									[P in keyof K as K[P] extends { optional: true } ? P : never]?: Infer<K[P]>;
								}
							>
						: never;

const string = (o: Omit<StringNode, 'kind'> = {}): StringNode => ({ kind: 'string', ...o });
const boolean = (): BooleanNode => ({ kind: 'boolean' });
const oneOf = <const V extends string>(values: readonly V[]): EnumNode<V> => ({
	kind: 'enum',
	values
});
const list = <N extends Node>(of: N): ListNode<N> => ({ kind: 'list', of });
const object = <K extends Record<string, Entry>>(keys: K): ObjectNode<K> => ({
	kind: 'object',
	keys
});
const optional = <N extends Node>(node: N): N & { optional: true } => ({ ...node, optional: true });
// Lowercase segments with no leading dot, so no `..`, no hidden file and no
// absolute path can reach outside static/.
const assetPath = (ext: RegExp, expect: string): StringNode =>
	string({
		pattern: new RegExp(`^(?:[a-z0-9][a-z0-9_-]*/)*[a-z0-9][a-z0-9_.-]*${ext.source}`),
		expect
	});

// The format versions this core reads. A skin opens with one of them.
export const SCHEMA_VERSIONS: readonly number[] = [1];

export const FIELD_TYPES = [
	'text',
	'longtext',
	'list',
	'year',
	'url',
	'email',
	'checkbox'
] as const;

// 'members': any signed-in member sees it on the profile, and search reads it.
// 'private': group admins only, stored apart, never searched.
export const FIELD_VISIBILITIES = ['members', 'private'] as const;

// A role is how core finds a field without knowing its key or label.
export const FIELD_ROLES = [
	// The member's whole name in one field. A skin has this, or the two parts.
	'name',
	'givenName',
	'familyName',
	'email',
	'handle',
	'bio',
	'tenureStart',
	'tenureEnd',
	'affiliation',
	'affiliationOther',
	'publicProfile',
	// The uploaded photo's URL. Written by the avatar route, never by the form.
	'avatar',
	// Kept so no value is lost, read by nothing. Never rendered or edited.
	'retired'
] as const;

// The form controls whose posted name is fixed and whose field is found by
// role. Every other control is named by its field's key (an affiliation box by
// `aff_` and its key, which no key can spell), so a key equal to one of these
// names is refused where it would put two controls of one name on a form.
export const ROLE_CONTROLS = {
	name: 'name',
	givenName: 'firstName',
	familyName: 'lastName',
	affiliationOther: 'otherAffiliations',
	publicProfile: 'publicProfile'
} as const satisfies Partial<Record<(typeof FIELD_ROLES)[number], string>>;

// The built-in option lists a single-line field's control can offer, each a
// select in the profile form. `cities` lists the cities of whatever the
// `countries` field holds. A field naming none of them is a free-text input,
// whatever its key or type.
export const OPTION_SETS = ['countries', 'cities', 'years', 'sizes', 'dialingCodes'] as const;

// Roles the profile form gives no text control: the identity key, the "Other"
// box (a fixed control), the avatar route's URL and the retired columns.
export const NO_TEXT_CONTROL_ROLES: readonly (typeof FIELD_ROLES)[number][] = [
	'email',
	'affiliationOther',
	'avatar',
	'retired'
];

// The member row's typed columns, derived from the fields that name one.
export const PROMOTED_COLUMNS = ['email', 'name', 'city', 'linkedin'] as const;

export const SKIN_SCHEMA = object({
	schema: { kind: 'version' },
	id: string({ pattern: /^[a-z0-9][a-z0-9-]*$/, expect: 'a lowercase slug (a-z, 0-9, -)' }),
	site: object({
		domain: string({
			pattern: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/,
			expect: 'a bare domain name'
		}),
		legal_name: string(),
		name: string(),
		default_group: string({
			pattern: /^[a-z0-9][a-z0-9-]*$/,
			expect: 'a group slug (a-z, 0-9, -)'
		})
	}),
	mail: object({
		from_name: string(),
		sign_in_subject: string(),
		signature: string(),
		credit: optional(
			object({
				name: string(),
				url: string({ pattern: /^https:\/\/[^\s"<>]+$/, expect: 'an https:// URL' })
			})
		)
	}),
	// Paths under the skin's static directory, which a build serves from the
	// site root. The loader checks each names a file there.
	brand: object({
		wordmark: assetPath(/\.(svg|png)$/, 'an .svg or .png path under static/'),
		mark: assetPath(/\.(svg|png)$/, 'an .svg or .png path under static/'),
		// Mail clients that render no SVG still show a PNG.
		email_logo: assetPath(/\.png$/, 'a .png path under static/')
	}),
	// Optional: a skin without it builds pages that make no third-party request.
	// The provider is one core knows, so a skin can switch analytics on but can
	// never add a script origin of its own to the Content-Security-Policy.
	analytics: optional(
		object({
			provider: oneOf(Object.keys(ANALYTICS_PROVIDERS) as (keyof typeof ANALYTICS_PROVIDERS)[]),
			site: string({ pattern: /^[A-Za-z0-9]+$/, expect: 'a site id (letters and digits)' })
		})
	),
	fields: list(
		object({
			key: string({
				pattern: /^[a-z][A-Za-z0-9]*$/,
				expect: 'a camelCase identifier (letters and digits, lowercase first)'
			}),
			label: string(),
			type: oneOf(FIELD_TYPES),
			visibility: oneOf(FIELD_VISIBILITIES),
			role: optional(oneOf(FIELD_ROLES)),
			column: optional(oneOf(PROMOTED_COLUMNS)),
			placeholder: optional(string()),
			options: optional(oneOf(OPTION_SETS)),
			required: optional(boolean())
		})
	)
});

export type Skin = Infer<typeof SKIN_SCHEMA>;
export type SkinField = Skin['fields'][number];

// The two ways a skin names a member: one whole-name field, or a given and a
// family name. Core cannot run without one of them, and reads the member row's
// name from the fields holding these roles. Every other role may be absent,
// and the feature that reads it is then off. That includes `email`: the
// sign-in address lives in the member row whether or not a profile field
// keeps a copy.
export const NAME_ROLE_SETS = [['name'], ['givenName', 'familyName']] as const;
// What heads the sign-in address in the CSV export where no email-role field
// lends it a label. No other field may then take it as a label.
export const LOGIN_LABEL = 'Email';
// 'affiliation' and 'retired' mark a set; each other role names one field.
const MANY_ROLES: ReadonlySet<string> = new Set(['affiliation', 'retired']);

export type SkinIssue = { path: string; found: string; expected: string };

export class SkinError extends Error {
	constructor(
		readonly file: string,
		readonly issues: readonly SkinIssue[]
	) {
		super(
			issues
				.map(
					(i) => `${file}: ${i.path ? `${i.path}: ` : ''}found ${i.found}, expected ${i.expected}`
				)
				.join('\n')
		);
		this.name = 'SkinError';
	}
}

const isMapping = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v);

function show(v: unknown): string {
	if (v === undefined) return 'nothing';
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'a list';
	if (typeof v === 'object') return 'a mapping';
	if (typeof v === 'string') return `the string ${JSON.stringify(v)}`;
	return `the ${typeof v} ${String(v)}`;
}

const versionsText = () => SCHEMA_VERSIONS.join(', ');

function typeText(node: Node): string {
	switch (node.kind) {
		case 'string':
			return 'string';
		case 'version':
			return `integer (${versionsText()})`;
		case 'boolean':
			return 'boolean';
		case 'enum':
			return `one of ${node.values.map((v) => `\`${v}\``).join(', ')}`;
		case 'list':
			return `list of ${node.of.kind === 'object' ? 'mappings' : `${typeText(node.of)}s`}`;
		case 'object':
			return 'mapping';
	}
}

function expectedText(node: Node): string {
	switch (node.kind) {
		case 'string':
			return node.expect ?? 'a string';
		case 'version':
			return `one of the schema versions this core reads (${versionsText()})`;
		case 'boolean':
			return 'true or false';
		case 'enum':
			return `one of ${node.values.join(', ')}`;
		case 'list':
			return 'a list';
		case 'object':
			return 'a mapping';
	}
}

function check(node: Node, value: unknown, path: string, issues: SkinIssue[]): void {
	const wrong = () => issues.push({ path, found: show(value), expected: expectedText(node) });
	switch (node.kind) {
		case 'string':
			if (typeof value !== 'string' || !value.trim()) return void wrong();
			if (node.pattern && !node.pattern.test(value)) wrong();
			return;
		case 'version':
			if (!SCHEMA_VERSIONS.includes(value as number)) wrong();
			return;
		case 'boolean':
			if (typeof value !== 'boolean') wrong();
			return;
		case 'enum':
			if (!node.values.includes(value as string)) wrong();
			return;
		case 'list':
			if (!Array.isArray(value)) return void wrong();
			value.forEach((item, i) => check(node.of, item, `${path}[${i}]`, issues));
			return;
		case 'object': {
			if (!isMapping(value)) return void wrong();
			const at = (key: string) => (path ? `${path}.${key}` : key);
			const known = Object.keys(node.keys);
			for (const key of Object.keys(value)) {
				if (!Object.hasOwn(node.keys, key)) {
					issues.push({
						path: at(key),
						found: 'an unknown key',
						expected: `one of ${known.join(', ')}`
					});
				}
			}
			for (const key of known) {
				const child = node.keys[key];
				if (value[key] === undefined) {
					if (!child.optional) {
						issues.push({
							path: at(key),
							found: 'nothing',
							expected: `${expectedText(child)} (required)`
						});
					}
					continue;
				}
				check(child, value[key], at(key), issues);
			}
		}
	}
}

// What the declaration cannot say key by key: no two fields share a key or a
// label (the label is the CSV column header), and roles have a cardinality.
function checkFields(fields: readonly SkinField[], issues: SkinIssue[]): void {
	for (const prop of ['key', 'label'] as const) {
		const first = new Map<string, number>();
		fields.forEach((f, i) => {
			const seen = first.get(f[prop]);
			if (seen === undefined) return void first.set(f[prop], i);
			issues.push({
				path: `fields[${i}].${prop}`,
				found: `${JSON.stringify(f[prop])} again (first at fields[${seen}])`,
				expected: `a ${prop} no other field uses`
			});
		});
	}
	for (const role of FIELD_ROLES) {
		const holders = fields.flatMap((f, i) => (f.role === role ? [i] : []));
		if (holders.length > 1 && !MANY_ROLES.has(role)) {
			issues.push({
				path: `fields[${holders[1]}].role`,
				found: `a second "${role}" field (first at fields[${holders[0]}])`,
				expected: `at most one field with role ${role}`
			});
		}
	}
	const held = new Set(fields.map((f) => f.role));
	const complete = NAME_ROLE_SETS.filter((set) => set.every((r) => held.has(r)));
	const partial = NAME_ROLE_SETS.flat().filter((r) => held.has(r));
	const wanted = 'one field with role name, or one each with roles givenName and familyName';
	if (complete.length !== 1 || partial.length !== complete[0].length) {
		issues.push({
			path: 'fields',
			found: partial.length ? `the name roles ${partial.join(', ')}` : 'no field with a name role',
			expected: wanted
		});
	}
	if (!held.has('email')) {
		fields.forEach((f, i) => {
			if (f.label.trim().toLowerCase() !== LOGIN_LABEL.toLowerCase()) return;
			issues.push({
				path: `fields[${i}].label`,
				found: `"${f.label}" on a field without role email`,
				expected: `another label, or role email (the export heads the sign-in address "${LOGIN_LABEL}")`
			});
		});
	}
	// The profile form posts a text field under its key and these two under a
	// fixed name. A key spelling that name on some other field would post two
	// values under it, and one of them would be saved as the other.
	for (const role of ['affiliationOther', 'publicProfile'] as const) {
		const holder = fields.findIndex((f) => f.role === role);
		const squatter = fields.findIndex((f) => f.key === ROLE_CONTROLS[role] && f.role !== role);
		if (holder < 0 || squatter < 0) continue;
		issues.push({
			path: `fields[${squatter}].key`,
			found: `"${ROLE_CONTROLS[role]}" on a field without role ${role} (held by fields[${holder}])`,
			expected: `another key (the profile form posts the ${role} field as "${ROLE_CONTROLS[role]}")`
		});
	}
	// `options` and `required` describe a control, so each is refused on a field
	// whose control could not honor it: set there, it would read as applied.
	const selects: Partial<Record<(typeof OPTION_SETS)[number], number>> = {};
	fields.forEach((f, i) => {
		const noControl =
			f.type === 'checkbox'
				? 'a checkbox field'
				: NO_TEXT_CONTROL_ROLES.includes(f.role as never)
					? `a field with role ${f.role}`
					: '';
		const multiline =
			f.role === 'bio'
				? 'a field with role bio'
				: f.type === 'longtext' || f.type === 'list'
					? `a ${f.type} field`
					: '';
		if (f.required !== undefined && noControl) {
			issues.push({
				path: `fields[${i}].required`,
				found: `${f.required} on ${noControl}`,
				expected: 'no required key (the profile form has no text control for this field)'
			});
		}
		if (f.options === undefined) return;
		if (noControl || multiline) {
			issues.push({
				path: `fields[${i}].options`,
				found: `"${f.options}" on ${noControl || multiline}`,
				expected: 'no options key (a multi-line control offers no list)'
			});
			return;
		}
		if (f.options !== 'countries' && f.options !== 'cities') return;
		const first = selects[f.options];
		if (first === undefined) return void (selects[f.options] = i);
		issues.push({
			path: `fields[${i}].options`,
			found: `a second "${f.options}" field (first at fields[${first}])`,
			expected: `at most one field with options ${f.options}`
		});
	});
	if (selects.cities !== undefined && selects.countries === undefined) {
		issues.push({
			path: `fields[${selects.cities}].options`,
			found: '"cities" with no field offering countries',
			expected: 'one field with options countries (the city list is the chosen country’s)'
		});
	}
	// member.name is read from the fields naming that column, so a name field
	// outside it would be stored and never shown as the member's name.
	fields.forEach((f, i) => {
		if ((NAME_ROLE_SETS.flat() as string[]).includes(f.role ?? '') && f.column !== 'name') {
			issues.push({
				path: `fields[${i}].column`,
				found: f.column ? `the string "${f.column}"` : 'nothing',
				expected: `name (a field with role ${f.role} feeds the member's name)`
			});
		}
	});
}

// Returns the value typed, or throws a SkinError listing every problem with
// its path. The version is judged first and alone: a skin from another format
// version would otherwise bury the one useful line under key errors that only
// say the same thing less clearly.
export function validateSkin(value: unknown, file: string): Skin {
	if (!isMapping(value)) {
		throw new SkinError(file, [{ path: '', found: show(value), expected: 'a mapping' }]);
	}
	const version = value.schema;
	if (version !== undefined && !SCHEMA_VERSIONS.includes(version as number)) {
		const newest = Math.max(...SCHEMA_VERSIONS);
		const direction =
			typeof version !== 'number'
				? ''
				: version > newest
					? '. This skin is newer than this core: pin a newer core release'
					: '. This skin is older than this core: migrate the skin or pin an older core release';
		throw new SkinError(file, [
			{
				path: 'schema',
				found: show(version),
				expected: `one of the schema versions this core reads (${versionsText()})${direction}`
			}
		]);
	}
	const issues: SkinIssue[] = [];
	check(SKIN_SCHEMA, value, '', issues);
	if (!issues.length) checkFields((value as Skin).fields, issues);
	if (issues.length) throw new SkinError(file, issues);
	return value as Skin;
}

// `file` is only ever a label for messages; nothing is read from it here.
export function parseSkin(text: string, file: string): Skin {
	let value: unknown;
	try {
		// The library's defaults already refuse a duplicate key. Merge keys stay
		// off so every value a reviewer reads is written where it applies.
		value = parse(text, { merge: false });
	} catch (e) {
		throw new SkinError(file, [
			{
				path: '',
				found: `invalid YAML (${(e as Error).message.trim()})`,
				expected: 'a YAML mapping'
			}
		]);
	}
	return validateSkin(value, file);
}

export type SchemaRow = { path: string; type: string; required: boolean };

// Every key in declaration order, as docs/skin.md lists them.
export function describeSkinSchema(): SchemaRow[] {
	const rows: SchemaRow[] = [];
	const walk = (node: Node, path: string): void => {
		const inner = node.kind === 'list' ? node.of : node;
		if (inner.kind !== 'object') return;
		const prefix = node.kind === 'list' ? `${path}[]` : path;
		for (const [key, child] of Object.entries(inner.keys)) {
			const at = prefix ? `${prefix}.${key}` : key;
			rows.push({ path: at, type: typeText(child), required: !child.optional });
			walk(child, at);
		}
	};
	walk(SKIN_SCHEMA, '');
	return rows;
}
