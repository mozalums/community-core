import { redirect, fail, error } from '@sveltejs/kit';
import { getGroupBySlug } from '$lib/server/groups';
import { groupBase, signInHref } from '$lib/group-nav';
import {
	submitRequest,
	requestData,
	AFFILIATIONS,
	OTHER_AFFILIATION_KEY
} from '$lib/server/requests';
import {
	AFFILIATION_CONTROL_PREFIX,
	HAS_AFFILIATIONS,
	OTHER_AFFILIATION_CONTROL,
	PUBLIC_PROFILE_CONTROL,
	PUBLIC_PROFILE_KEY
} from '$lib/server/affiliations';
import { nameFields, optionalFieldByRole, promotedColumns } from '$lib/server/field-schema';
import { editableFor, linkRows } from '$lib/server/member-edit';
import { checkLinks, renderLinks, type LinkEntry } from '$lib/links';
import { ROLE_CONTROLS } from '$lib/skin/schema';
import { sendMembershipRequestNotice } from '$lib/server/email';
import { hashId, rateLimitKey, rateLimited } from '$lib/server/rate-limit';
import { log } from '$lib/server/log';
import type { Actions, PageServerLoad } from './$types';

// The form's controls have fixed names; the field each one is stored under is
// the skin's. A name control is bound to its field by role, never by where
// the skin lists it: the skin's order decides only the order the controls are
// shown in and the order the parts join into the member's name. A skin names
// a member with one field (the `name` control) or with a given and a family
// name (`firstName`, `lastName`). The form asks for an affiliation only where
// the skin has a field to keep the answer in, and shows the skin's links
// fields as the profile form does. A control is required exactly where the
// skin marks its field `required`, in the browser and here alike; an
// affiliation is never required, as a checkbox field has no `required` key.
type NameRole = 'name' | 'givenName' | 'familyName';
// The words the form labels each control with, which a refusal repeats.
const CONTROL_LABELS: Record<string, string> = {
	name: 'Name',
	firstName: 'First name',
	lastName: 'Last name'
};
const NAME_CONTROLS = nameFields().map((f) => ({
	control: ROLE_CONTROLS[f.role as NameRole],
	key: f.key,
	required: !!f.required
}));
const LINK_FIELDS = editableFor().flatMap((f) =>
	f.links ? [{ name: f.name, label: f.label, required: !!f.required, sites: f.links }] : []
);

// Each submission mails the admins, and a pending request is updated in place,
// so the cap bounds mail rather than rows. A denied requester can still apply
// again: the cap slows a loop, it does not close the door.
const SUBMIT_MAX = 5;
const SUBMIT_WINDOW = 3600;

export const load: PageServerLoad = async ({ parent, params, locals, url }) => {
	const { member, isGroupAdmin } = await parent();
	// Members and admins are already in — to the directory.
	if (member || isGroupAdmin) {
		throw redirect(303, `${groupBase(url.pathname, params.slug)}/members`);
	}
	// Must be signed in to request (we capture their verified identity).
	if (!locals.user) throw redirect(303, signInHref(url.pathname, params.slug));

	const group = await getGroupBySlug(params.slug);
	if (!group) throw error(404, 'No such community');

	// Seed first/last from the login name if present.
	const fullName = (locals.user.name ?? '').trim();
	const sp = fullName.indexOf(' ');
	const firstName = fullName ? (sp > 0 ? fullName.slice(0, sp) : fullName) : '';
	const lastName = fullName && sp > 0 ? fullName.slice(sp + 1) : '';

	return {
		email: locals.user.email ?? '',
		prefill: { name: fullName, firstName, lastName },
		affiliations: AFFILIATIONS.map((a) => ({ key: a.key, label: a.label })),
		nameControls: NAME_CONTROLS.map(({ control, required }) => ({ control, required })),
		linkFields: LINK_FIELDS,
		asks: {
			affiliation: HAS_AFFILIATIONS,
			otherAffiliation: OTHER_AFFILIATION_KEY !== undefined,
			publicProfile: PUBLIC_PROFILE_KEY !== undefined
		},
		// The "Other" box's hint is its field's, so the examples are the skin's.
		otherPlaceholder: optionalFieldByRole('affiliationOther')?.placeholder ?? ''
	};
};

// What a refused submit hands back: the message, the field it names, and
// everything entered, so the form refills as the requester left it.
type Refusal = {
	error: string;
	fieldError?: { name: string; message: string };
	values?: Record<string, string>;
	links?: Record<string, LinkEntry[]>;
	checked?: string[];
	publicProfile?: boolean;
};
const refuse = (status: number, r: Refusal) => fail(status, r);

export const actions: Actions = {
	default: async ({ request, params, locals, url }) => {
		if (!locals.user) throw redirect(303, signInHref(url.pathname, params.slug));
		const group = await getGroupBySlug(params.slug);
		if (!group) return refuse(404, { error: 'No such community' });
		const email = locals.user.email;
		if (!email)
			return refuse(400, { error: 'A verified email is required to request membership.' });

		const form = await request.formData();
		const field = (control: string) => String(form.get(control) ?? '').trim();
		const nameValues: Record<string, string> = {};
		const updates: Record<string, string> = {};
		for (const c of NAME_CONTROLS) updates[c.key] = nameValues[c.control] = field(c.control);
		const links: Record<string, LinkEntry[]> = {};
		for (const f of LINK_FIELDS) {
			links[f.name] = linkRows(
				form.getAll(`${f.name}:site`).map((v) => String(v).trim()),
				form.getAll(`${f.name}:handle`).map((v) => String(v).trim())
			);
		}
		const other = field(OTHER_AFFILIATION_CONTROL);
		const checked = AFFILIATIONS.filter(
			(a) => form.get(`${AFFILIATION_CONTROL_PREFIX}${a.key}`) != null
		).map((a) => a.key);
		const publicProfile = form.get(PUBLIC_PROFILE_CONTROL) != null;

		const values = { ...nameValues, [OTHER_AFFILIATION_CONTROL]: other };
		// Echoed back on every rejection so a validation error never silently
		// resets a privacy choice the requester already made.
		const entered = { values, links, checked, publicProfile };
		const missing = NAME_CONTROLS.find((c) => c.required && !nameValues[c.control]);
		if (missing) {
			return refuse(400, { error: `${CONTROL_LABELS[missing.control]} is required.`, ...entered });
		}
		// Approval writes these through the profile save check, so a value it
		// would refuse is refused here, while the requester can still fix it.
		const checkedLinks: Record<string, LinkEntry[]> = {};
		for (const f of LINK_FIELDS) {
			const refuseField = (message: string) =>
				refuse(400, { error: message, fieldError: { name: f.name, message }, ...entered });
			if (f.required && !links[f.name].length)
				return refuseField(`${f.label}: at least one link is required.`);
			const c = checkLinks(links[f.name], f.sites);
			if (!c.ok) return refuseField(c.message);
			checkedLinks[f.name] = c.entries;
		}

		const extraByKey: Record<string, string | boolean> = {};
		if (OTHER_AFFILIATION_KEY) extraByKey[OTHER_AFFILIATION_KEY] = other;
		// Registering does not publish anyone: this is whatever the requester
		// ticked on the form, and unticked is the default. Stored explicitly
		// rather than left out, so approval copies a decision rather than an
		// absence some later reader gets to interpret.
		if (PUBLIC_PROFILE_KEY) extraByKey[PUBLIC_PROFILE_KEY] = publicProfile;
		for (const a of AFFILIATIONS) {
			extraByKey[a.key] = checked.includes(a.key);
		}

		if (await rateLimited(rateLimitKey('request-rl:e', hashId(email)), SUBMIT_MAX, SUBMIT_WINDOW)) {
			log.warn('membership-request.rejected', { groupId: group.id, reason: 'rate-limited' });
			return refuse(429, {
				error: 'Too many submissions from this address. Try again in an hour.',
				...entered
			});
		}

		// The name the admins' list and notice show: the parts joined as approval
		// will join them into the member row.
		const name = promotedColumns(updates).name ?? '';
		try {
			const data = requestData(email, updates, extraByKey, checkedLinks);
			const r = await submitRequest(
				group,
				{ email, subject: locals.user.subject ?? null },
				data,
				name
			);
			log.info('membership-request.submitted', {
				groupId: group.id,
				requestId: r.id,
				resubmitted: r.resubmitted
			});
		} catch (e) {
			log.error('membership-request.failed', { groupId: group.id, error: e as Error });
			return refuse(500, {
				error: `Could not submit your request — ${(e as Error).message}`,
				...entered
			});
		}

		// Notify an admin (best-effort — never fail the request on a mail error).
		const summary = [
			...AFFILIATIONS.filter((a) => checked.includes(a.key)).map((a) => a.label),
			...(other ? [`Other: ${other}`] : [])
		].join(', ');
		const reviewUrl = `${url.origin}${groupBase(url.pathname, params.slug)}/admin/requests`;
		try {
			const notified = await sendMembershipRequestNotice({
				groupName: group.name,
				requesterEmail: email,
				rows: [
					{ label: 'Name', value: name },
					{ label: 'Email', value: email },
					{ label: 'Associated with', value: summary },
					...LINK_FIELDS.flatMap((f) =>
						renderLinks(checkedLinks[f.name], f.sites).map((l) => ({
							label: l.label,
							value: l.href
						}))
					)
				],
				reviewUrl
			});
			if (!notified) {
				log.warn('membership-request.notify-skipped', { reason: 'NOTIFY_ADMIN_ADDRESS unset' });
			}
		} catch (e) {
			log.error('membership-request.notify-failed', { groupId: group.id, error: e as Error });
		}

		return { submitted: true };
	}
};
