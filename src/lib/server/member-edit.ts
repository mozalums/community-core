// Profile editing: the edit form's values, read from the member row, and the
// save, which goes through member-write.ts like every other member write.
//
// Which fields are editable, their labels and order, come from the field
// schema. Email is intentionally NOT editable — it's the identity key used to
// match logins to a member.

import {
	AFFILIATIONS,
	AFFILIATION_CONTROL_PREFIX,
	OTHER_AFFILIATION_CONTROL,
	OTHER_AFFILIATION_KEY,
	PUBLIC_PROFILE_CONTROL,
	PUBLIC_PROFILE_KEY,
	isChecked
} from '$lib/server/affiliations';
import {
	editableFields,
	ownValue,
	promotedKeys,
	type OptionSet,
	type PromotedColumn
} from '$lib/server/field-schema';
import {
	MemberWriteError,
	setUsernameIn,
	updateMember,
	type Authority,
	type Patch
} from '$lib/server/member-write';
import { USERNAME_CONTROL, checkUsername } from '$lib/server/usernames';
import type { Member, MemberWithPrivate, Actor } from '$lib/server/members';
import type { Group } from '$lib/server/groups';

export type EditField = {
	name: string;
	label: string;
	value: string;
	multiline?: boolean;
	private?: boolean;
	bio?: boolean;
	placeholder?: string;
	options?: OptionSet;
	required?: boolean;
	url?: boolean;
};
export type FieldSpec = {
	// The field-schema key, which is also the form control's name.
	name: string;
	label: string;
	multiline?: boolean;
	// Private fields are edited in a separate section and only shown to admins on
	// the profile.
	private?: boolean;
	// The bio-role field, which the form sets apart at the top whatever its key.
	bio?: boolean;
	placeholder?: string;
	// The built-in list the control offers as a select; a free-text control
	// without one. Declared by the skin, like `required`: neither is ever
	// inferred from the key, which a skin spells as it likes.
	options?: OptionSet;
	// The control refuses an empty answer.
	required?: boolean;
	// A `type: url` field, which the form offers as a URL input.
	url?: boolean;
};

// The profile form's text fields, in schema order. Shared with the
// membership-request form (requests.ts).
export function editableFor(): FieldSpec[] {
	return editableFields().map((f) => ({
		name: f.key,
		label: f.label,
		multiline: f.type === 'longtext' || f.type === 'list' || undefined,
		private: f.visibility === 'private' || undefined,
		bio: f.role === 'bio' || undefined,
		placeholder: f.placeholder,
		options: f.options,
		required: f.required || undefined,
		url: f.type === 'url' || undefined
	}));
}

// The form field names, in order.
export const EDITABLE_NAMES = editableFor().map((f) => f.name);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function valuesOf(member: MemberWithPrivate): Record<string, unknown> {
	return { ...member.privateData, ...member.data };
}

const asText = (v: unknown) => (v == null ? '' : String(v));

// The typed columns the form can rebuild on save, each from the fields naming it.
const TYPED: readonly Exclude<PromotedColumn, 'email'>[] = ['name', 'city', 'linkedin'];

// A member whose typed column has none of its fields stored (a sheet row that
// carried a "Full Name" rather than First and Last) gets that column's form
// controls filled from the typed value, so the form shows a name to edit. Two
// fields split at the first space, as the old editor did for first + last; one
// takes the whole value. A column with any field stored is left alone: filling
// the missing one from the joined value would join that part twice on save.
function typedFallbacks(
	member: MemberWithPrivate,
	values: Record<string, unknown>
): Record<string, string> {
	const editable = new Set(EDITABLE_NAMES);
	const out: Record<string, string> = {};
	for (const c of TYPED) {
		const keys = promotedKeys(c).filter((k) => editable.has(k));
		const full = (member[c] ?? '').trim();
		if (!full || !keys.length || keys.some((k) => asText(ownValue(values, k)).trim())) continue;
		if (keys.length === 2) {
			const sp = full.indexOf(' ');
			out[keys[0]] = sp > 0 ? full.slice(0, sp) : full;
			out[keys[1]] = sp > 0 ? full.slice(sp + 1) : '';
		} else {
			out[keys[0]] = full;
		}
	}
	return out;
}

// Current editable values for a member, every editable field, keyed by field.
export function readEditFields(member: MemberWithPrivate): EditField[] {
	const values = valuesOf(member);
	const fallback = typedFallbacks(member, values);
	return editableFor().map((f) => ({
		name: f.name,
		label: f.label,
		value: asText(ownValue(values, f.name)) || (ownValue(fallback, f.name) ?? ''),
		multiline: f.multiline,
		private: f.private,
		bio: f.bio,
		placeholder: f.placeholder,
		options: f.options,
		required: f.required,
		url: f.url
	}));
}

export type AffiliationState = {
	checks: Record<string, boolean>;
	other: string;
	publicProfile: boolean;
};

// The member's affiliation checkboxes + free-text "Other" + the public-profile
// opt-in. Missing values read as unchecked / empty.
export function readAffiliations(member: Pick<Member, 'data'>): AffiliationState {
	const get = (key: string) => ownValue(member.data, key);
	const checks: Record<string, boolean> = {};
	for (const a of AFFILIATIONS) checks[a.key] = isChecked(get(a.key));
	return {
		checks,
		other: OTHER_AFFILIATION_KEY ? asText(get(OTHER_AFFILIATION_KEY)).trim() : '',
		publicProfile: PUBLIC_PROFILE_KEY ? isChecked(get(PUBLIC_PROFILE_KEY)) : false
	};
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type ProfileUpdate = {
	// field key → value, every text field the form submitted. Passed through
	// whole, so a name the schema does not know is refused rather than dropped.
	updates: Record<string, string>;
	// affiliation key → checked. A known box absent here is unticked.
	checks: Record<string, boolean>;
	other: string;
	publicProfile: boolean;
};

// The form's controls as one patch: text fields, every affiliation checkbox
// (an unticked box is absent from a form post, so absent means false), the
// free-text "Other" and the public-profile opt-in.
export function profilePatch(u: ProfileUpdate): Patch {
	const patch: Patch = Object.assign(ownKeys<string | boolean>(), u.updates);
	for (const a of AFFILIATIONS) patch[a.key] = false;
	for (const [key, on] of Object.entries(u.checks)) patch[key] = on;
	if (OTHER_AFFILIATION_KEY) patch[OTHER_AFFILIATION_KEY] = u.other;
	if (PUBLIC_PROFILE_KEY) patch[PUBLIC_PROFILE_KEY] = u.publicProfile;
	return patch;
}

// Posted names are attacker-chosen. On an ordinary object, assigning to
// `__proto__` runs the inherited setter instead of creating a key, so the name
// never reaches validation and the save commits without it. A null-prototype
// record keeps every name as its own key.
const ownKeys = <T>(): Record<string, T> => Object.create(null);

// Every control the form posted. A text field posts under its key; a ticked
// affiliation box as aff_<key>, an unticked one as nothing; the free-text
// "Other" and the public-profile box under fixed names, whose fields the skin
// keys as it likes and profilePatch finds by role. Nothing is filtered here: a
// name the field schema does not know reaches the write path and is refused
// there, and so does a fixed name on a skin with no field in that role.
export function formUpdate(form: FormData): ProfileUpdate {
	const u: ProfileUpdate = {
		updates: ownKeys(),
		checks: ownKeys(),
		other: '',
		publicProfile: false
	};
	for (const [name, v] of form) {
		const value = typeof v === 'string' ? v.trim() : '';
		if (name.startsWith(AFFILIATION_CONTROL_PREFIX)) {
			u.checks[name.slice(AFFILIATION_CONTROL_PREFIX.length)] = true;
		} else if (name === OTHER_AFFILIATION_CONTROL && OTHER_AFFILIATION_KEY) u.other = value;
		else if (name === PUBLIC_PROFILE_CONTROL && PUBLIC_PROFILE_KEY) u.publicProfile = true;
		else u.updates[name] = value;
	}
	return u;
}

// What a refused save hands back to refill the form: the fields the form
// renders, as a plain object. The posted record can hold any name, and the
// serializer SvelteKit returns action data through rejects a `__proto__` key
// with a 500, which would replace the 400 the write path decided.
export function formEcho(u: ProfileUpdate): Record<string, string> {
	const echo: Record<string, string> = {};
	for (const f of editableFields()) {
		if (Object.hasOwn(u.updates, f.key)) echo[f.key] = u.updates[f.key];
	}
	return echo;
}

// The same for the controls that are not text fields, so a refused save does
// not put a privacy choice back to what is stored. Boxes are read off the
// skin's own list, never off the posted names.
export function choiceEcho(u: ProfileUpdate): AffiliationState {
	const checks: Record<string, boolean> = {};
	for (const a of AFFILIATIONS) checks[a.key] = Object.hasOwn(u.checks, a.key);
	return { checks, other: u.other, publicProfile: u.publicProfile };
}

// Save a profile. Returns the number of fields actually changed. Throws
// MemberWriteError (400 unknown or uneditable field or a refused username, 403
// a private field without authority, 404 a member gone since the form
// rendered, 409 a username another member holds). A username, when the form
// posted one, commits or rolls back with the rest, so a save refused for a
// taken name changes nothing.
export async function saveMemberProfile(
	group: Group,
	member: Pick<Member, 'id'>,
	u: ProfileUpdate,
	actor: Actor,
	authority: Authority,
	username?: string
): Promise<number> {
	let next: string | null = null;
	if (username?.trim()) {
		const v = checkUsername(username);
		if (!v.ok) throw new MemberWriteError(400, `Username: ${v.message}`, USERNAME_CONTROL);
		next = v.name;
	}
	return updateMember(group, member.id, profilePatch(u), actor, authority, {
		also:
			username === undefined
				? undefined
				: (client) =>
						setUsernameIn(client, {
							group,
							memberId: member.id,
							next,
							field: USERNAME_CONTROL,
							actor
						})
	});
}
