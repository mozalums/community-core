import { error, redirect } from '@sveltejs/kit';
import { canonicalMemberUrl, memberRef } from '$lib/group-nav';
import { getGroupBySlug } from '$lib/server/groups';
import { getMemberById, canEditMember } from '$lib/server/members';
import {
	fieldsFor,
	filterFields,
	isChecked,
	isMembersVisibleKey,
	filterColumn,
	ownValue,
	type FieldDef,
	type FieldRole
} from '$lib/server/field-schema';
import { avatarIdFor } from '$lib/server/avatars';
import { profileHref } from '$lib/server/profile-url';
import { isStarred } from '$lib/server/stars';
import type { PageServerLoad } from './$types';

// Member profile. Sits under the members-gate layout, so it's members-only.
// Renders every field the caller may see, in field-schema order: a
// members-visible field for any member, a private one for a group admin only.
// What a field shows is a property of the field, not of this page, so a field
// added to the schema appears here without an edit to this file.

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
	// Set on a url field only when its value passes the save check; the page
	// links nothing else.
	href?: string;
	// Set on a field the directory filters on: the query string (no `?`) that
	// finds the members holding this value in this field.
	filter?: string;
};

export const load: PageServerLoad = async ({ params, locals, parent, url }) => {
	// First, so the members gate runs even when a client requests this leaf's
	// data alone and SvelteKit would otherwise skip the layouts.
	const { member: viewer, isGroupAdmin } = await parent();
	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');
	// The segment is a uuid or a username, current or retired. Every form but
	// the canonical one answers 308 to it, after the gate above, so the
	// redirect is never news to someone who could not read the directory.
	const member = await getMemberById(group.id, params.id);
	if (!member) throw error(404, 'No such member');
	const ref = memberRef(member);
	const canonical = canonicalMemberUrl(url, params.id, ref);
	if (canonical) throw redirect(308, canonical);

	// Show the Edit affordance to the member themselves or a group admin.
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

	// A filter compares the value the directory reads (filterColumn): the city
	// column for the city field, else the stored value at the field's key.
	// A city is only unambiguous within its country, so a city filter carries
	// the country this profile holds, found as the field the city list is keyed
	// by.
	const filterable = new Set(filterFields().map((f) => f.key));
	const filterValueOf = (f: FieldDef): string | null => {
		const own = filterColumn(f);
		const v = stored(f);
		const s = (own ? (columns[own] ?? '') : '').trim() || (v == null ? '' : String(v));
		return s.trim() || null;
	};
	const pair = (f: FieldDef, v: string) => `${f.key}=${encodeURIComponent(v)}`;
	const countryField = fields.find((f) => f.options === 'countries' && filterable.has(f.key));
	const filterOf = (f: FieldDef): string | undefined => {
		const value = filterable.has(f.key) ? filterValueOf(f) : null;
		if (!value) return undefined;
		const country = f.options === 'cities' && countryField ? filterValueOf(countryField) : null;
		return [pair(f, value), ...(country ? [pair(countryField!, country)] : [])].join('&');
	};

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
		if (!value) continue;
		const href = f.type === 'url' ? profileHref(value) : null;
		const filter = filterOf(f);
		details.push({
			key: f.key,
			label: f.label,
			type: f.type,
			value,
			...(href ? { href } : {}),
			...(filter ? { filter } : {})
		});
	}

	// requireDirectoryAccess, read from what the group layout already resolved:
	// a signed-in synced member or a group admin. The star endpoint applies the
	// same rule and does not refuse a self-star, so neither does this.
	const starrer = locals.user && (viewer || isGroupAdmin) ? locals.user.subject : null;
	// Like the directory, a failed star lookup costs the star, not the page.
	const starred = starrer
		? await isStarred(group.id, starrer, member.id).catch(() => false)
		: undefined;

	return {
		profile: {
			id: member.id,
			ref,
			name: member.name,
			handle: one('handle'),
			email: one('email'),
			bio: one('bio'),
			details,
			// null on error: with no id there is no URL to try, so the card falls
			// back to initials.
			avatarId: await avatarIdFor(member.email).catch(() => null)
		},
		canEdit,
		...(starred === undefined ? {} : { starred }),
		privateFields: isGroupAdmin ? privateFields : null
	};
};
