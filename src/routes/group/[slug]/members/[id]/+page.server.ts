import { error } from '@sveltejs/kit';
import { getGroupBySlug } from '$lib/server/groups';
import { getMemberById, canEditMember } from '$lib/server/members';
import {
	fieldsFor,
	isChecked,
	isMembersVisibleKey,
	ownValue,
	type FieldDef,
	type FieldRole
} from '$lib/server/field-schema';
import { avatarIdFor } from '$lib/server/avatars';
import { gravatarHash } from '$lib/server/gravatar';
import type { PageServerLoad } from './$types';

// Member profile. Sits under the members-gate layout, so it's members-only.
// Renders every field the caller may see, in field-schema order: a
// members-visible field for any member, a private one for a group admin only.
// What a field shows is a property of the field, not of this page, so a field
// added to the schema appears here without an edit to this file.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Rendered by the card itself (name, address, handle, bio), folded into
// "Associated with", a flag rather than something to read, or kept for the
// record and read by nothing.
const OWN_PLACE: ReadonlySet<FieldRole | undefined> = new Set<FieldRole | undefined>([
	'name',
	'givenName',
	'familyName',
	'email',
	'handle',
	'bio',
	'affiliation',
	'affiliationOther',
	'publicProfile',
	'retired'
]);

export type ProfileDetail = {
	key: string;
	label: string;
	type: FieldDef['type'] | 'tags';
	value: string;
	tags?: string[];
};

export const load: PageServerLoad = async ({ params, locals, parent }) => {
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');
	if (!UUID.test(params.id)) throw error(404, 'No such member');

	const member = await getMemberById(group.id, params.id);
	if (!member) throw error(404, 'No such member');

	// Show the Edit affordance to the member themselves or a group admin.
	const { isGroupAdmin } = await parent();
	const canEdit = canEditMember(member, locals.user, isGroupAdmin);

	// Private values are not even read for a non-admin.
	const values: Record<string, unknown> = isGroupAdmin
		? { ...member.privateData, ...member.data }
		: { ...member.data };
	const columns: Record<string, string | null> = {
		email: member.email,
		name: member.name,
		city: member.city,
		linkedin: member.linkedin
	};
	// Visibility gates the promoted column as well as the jsonb copy: a private
	// field whose value also sits in a typed column would otherwise reach the
	// page through the column. The column comes first because a row the sheet
	// filled may hold it with no field stored behind it.
	const visible = (f: FieldDef) => isMembersVisibleKey(f.key) || isGroupAdmin;
	const stored = (f: FieldDef): unknown => ownValue(values, f.key);
	const valueOf = (f: FieldDef): string | null => {
		if (!visible(f)) return null;
		const v = stored(f);
		const s = (f.column ? (columns[f.column] ?? '') : '').trim() || (v == null ? '' : String(v));
		return s.trim() || null;
	};
	const fields = fieldsFor(Object.keys(values));
	const byRole = (role: FieldRole) => fields.filter((f) => f.role === role);
	const one = (role: FieldRole) => {
		const f = byRole(role)[0];
		return f ? valueOf(f) : null;
	};

	// "Associated with": the affiliation boxes the member has ticked plus any
	// free-text Other, split into tokens, each a directory-search link.
	const associations = [
		...byRole('affiliation')
			.filter((f) => visible(f) && isChecked(stored(f)))
			.map((f) => f.label),
		...byRole('affiliationOther').flatMap((f) =>
			(valueOf(f) ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
		)
	];

	const details: ProfileDetail[] = [];
	const privateFields: { key: string; label: string; value: string | null }[] = [];
	let associationsPlaced = false;
	for (const f of fields) {
		if (f.role === 'affiliation' || f.role === 'affiliationOther') {
			if (!associationsPlaced && associations.length) {
				details.push({
					key: 'associations',
					label: 'Associated with',
					type: 'tags',
					value: '',
					tags: associations
				});
			}
			associationsPlaced = true;
			continue;
		}
		if (OWN_PLACE.has(f.role)) continue;
		if (f.visibility === 'private') {
			if (isGroupAdmin) privateFields.push({ key: f.key, label: f.label, value: valueOf(f) });
			continue;
		}
		const value = valueOf(f);
		if (value) details.push({ key: f.key, label: f.label, type: f.type, value });
	}

	return {
		profile: {
			id: member.id,
			name: member.name,
			handle: one('handle'),
			email: one('email'),
			gravatarHash: gravatarHash(member.email),
			bio: one('bio'),
			details,
			// null on error: with no id there is no URL to try, so the card falls
			// back to Gravatar and then to initials.
			avatarId: await avatarIdFor(member.email).catch(() => null)
		},
		canEdit,
		privateFields: isGroupAdmin ? privateFields : null
	};
};
