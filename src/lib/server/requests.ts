// Membership requests, in access_request. A signed-in non-member submits a
// profile-shaped form; an admin approves it into a member row or denies it.
// Every row is kept: a decision sets status, never deletes, so a denial stays
// visible beside a later resubmission.
//
// `data` is keyed by field-schema key, as member.data is, and holds private
// values too: approval splits it into data and private_data by each field's
// visibility and derives the typed columns from its fields, the same two
// steps a profile save takes.

import { query, withTransaction } from '$lib/server/postgres';
import { auditIn, type AuditEntry } from '$lib/server/audit-core';
import { editableFor } from '$lib/server/member-edit';
import { AFFILIATIONS, OTHER_AFFILIATION_KEY, isChecked } from '$lib/server/affiliations';
import {
	DEFAULT_FIELD_SCHEMA,
	fieldsFor,
	nameFields,
	optionalFieldByRole,
	ownValue
} from '$lib/server/field-schema';
import { createMemberIn, type Patch } from '$lib/server/member-write';
import type { Group } from '$lib/server/groups';

export { AFFILIATIONS, OTHER_AFFILIATION_KEY };

export type Actor = Pick<AuditEntry, 'actorSubject' | 'actorEmail'>;

export type MembershipRequest = {
	id: string;
	email: string;
	name: string;
	details: { label: string; value: string }[];
	/** Earlier denials of this address in this group, newest first. */
	priorDenials: { at: string; reason: string | null }[];
};

// The form's values keyed by field-schema key. A checkbox is stored as the
// text a sheet checkbox reads back as, so the public-profile predicate and the
// affiliation search treat a native member exactly like a synced one.
//
// `updates` is keyed by field key, and a key that is not an editable field is
// refused rather than dropped: a caller that posts under a name the skin does
// not declare would otherwise report a submission that stored nothing.
export function requestData(
	email: string,
	updates: Record<string, string>,
	byKey: Record<string, string | boolean>
): Record<string, string> {
	const data: Record<string, string> = {};
	// The address keys the request row itself. A skin that also keeps it as a
	// profile field gets the copy; one that does not loses nothing.
	const emailField = optionalFieldByRole('email');
	if (emailField) data[emailField.key] = email;
	const editable = new Set(editableFor().map((f) => f.name));
	for (const [key, value] of Object.entries(updates)) {
		if (!editable.has(key)) throw new Error(`the request names "${key}", which is not a field`);
		const v = value.trim();
		if (v) data[key] = v;
	}
	for (const [key, value] of Object.entries(byKey)) {
		const v = typeof value === 'boolean' ? (value ? 'TRUE' : 'FALSE') : value.trim();
		if (v) data[key] = v;
	}
	return data;
}

// Submitting while a request is pending updates it in place: the partial unique
// index on (group_id, email) WHERE status = 'pending' is the conflict target.
// A denied or approved row is outside that index, so submitting after a denial
// inserts a new pending row and the denial survives beside it.
export async function submitRequest(
	group: Group,
	who: { email: string; subject: string | null },
	data: Record<string, string>,
	name: string
): Promise<{ id: string; resubmitted: boolean }> {
	return withTransaction(async (client) => {
		const { rows } = await client.query<{ id: string; inserted: boolean }>(
			`INSERT INTO access_request (group_id, email, ident_subject, name, data)
			 VALUES ($1, $2, $3, $4, $5::jsonb)
			 ON CONFLICT (group_id, email) WHERE status = 'pending'
			 DO UPDATE SET ident_subject = EXCLUDED.ident_subject,
			               name = EXCLUDED.name,
			               data = EXCLUDED.data,
			               updated_at = now()
			 RETURNING id, (xmax = 0) AS inserted`,
			[group.id, who.email, who.subject, name || null, JSON.stringify(data)]
		);
		const row = rows[0];
		await auditIn(client, {
			actorSubject: who.subject,
			actorEmail: who.email,
			category: 'membership',
			action: 'request.submitted',
			groupId: group.id,
			groupSlug: group.slug,
			targetEmail: who.email,
			targetSubject: who.subject,
			targetId: row.id,
			after: data,
			meta: { resubmitted: !row.inserted }
		});
		return { id: row.id, resubmitted: !row.inserted };
	});
}

type PendingRow = {
	id: string;
	email: string;
	name: string | null;
	data: Record<string, unknown>;
	denials: { at: string; reason: string | null }[];
};

export async function listRequests(group: Group): Promise<MembershipRequest[]> {
	const { rows } = await query<PendingRow>(
		`SELECT r.id, r.email::text AS email, r.name, r.data,
		        COALESCE((
		          SELECT json_agg(json_build_object('at', d.decided_at, 'reason', d.deny_reason)
		                          ORDER BY d.decided_at DESC)
		            FROM access_request d
		           WHERE d.group_id = r.group_id AND d.email = r.email AND d.status = 'denied'
		        ), '[]'::json) AS denials
		   FROM access_request r
		  WHERE r.group_id = $1 AND r.status = 'pending'
		  ORDER BY r.created_at`,
		[group.id]
	);
	const nameParts = new Set(nameFields().map((f) => f.key));
	const specs = editableFor().filter((s) => !nameParts.has(s.name));
	return rows.map((r) => {
		const data = r.data ?? {};
		const get = (key: string) => String(ownValue(data, key) ?? '').trim();

		const affiliations = AFFILIATIONS.filter((a) => isChecked(get(a.key))).map((a) => a.label);
		const other = OTHER_AFFILIATION_KEY ? get(OTHER_AFFILIATION_KEY) : '';
		const assoc = [...affiliations, ...(other ? [other] : [])].join(', ');
		const rest = specs.map((s) => ({ label: s.label, value: get(s.name) })).filter((d) => d.value);

		return {
			id: r.id,
			email: r.email,
			name: r.name ?? '',
			details: assoc ? [{ label: 'Associated with', value: assoc }, ...rest] : rest,
			priorDenials: r.denials ?? []
		};
	});
}

export type Approved = { email: string; memberId: string | null };

// One transaction. The row lock plus `status = 'pending'` in the predicate is
// what makes a second approval of the same request a no-op: it waits for the
// first to commit, then matches nothing. Returns null for a request that is not
// pending in this group, which the caller reports as a refusal.
//
// An address that is already an active member keeps its profile: the upsert
// only rewrites a member row that is not active, so approving a stale request
// cannot overwrite someone's edits with what they typed on the form.
export async function approveRequest(
	group: Group,
	id: string,
	actor: Actor
): Promise<Approved | null> {
	return withTransaction(async (client) => {
		const { rows } = await client.query<{ email: string; data: Record<string, string> }>(
			`SELECT email::text AS email, data FROM access_request
			  WHERE id = $1 AND group_id = $2 AND status = 'pending'
			  FOR UPDATE`,
			[id, group.id]
		);
		const req = rows[0];
		if (!req) return null;

		const email = req.email.trim().toLowerCase();
		if (!email) throw new Error('request has no email to key a member on');
		const memberId = await createMemberIn(client, {
			group,
			email,
			values: requestPatch(req.data ?? {}),
			actor,
			meta: { requestId: id }
		});

		await client.query(
			`UPDATE access_request
			    SET status = 'approved', decided_at = now(), decided_by = $2, updated_at = now()
			  WHERE id = $1`,
			[id, actor.actorSubject ?? null]
		);
		await auditIn(client, {
			...actor,
			category: 'authz',
			action: 'request.approved',
			groupId: group.id,
			groupSlug: group.slug,
			targetEmail: email,
			targetId: id,
			meta: { memberId, alreadyMember: memberId === null }
		});
		return { email, memberId };
	});
}

// access_request.data holds checkboxes in stored form ("TRUE"/"FALSE"); the
// write path takes them as booleans.
function requestPatch(data: Record<string, unknown>): Patch {
	const checkbox = new Set(
		fieldsFor(Object.keys(data), DEFAULT_FIELD_SCHEMA)
			.filter((f) => f.type === 'checkbox')
			.map((f) => f.key)
	);
	return Object.fromEntries(
		Object.entries(data).map(([k, v]) => [k, checkbox.has(k) ? isChecked(v) : String(v ?? '')])
	);
}

// Same predicate as approval; a single UPDATE takes the row lock itself.
export async function denyRequest(
	group: Group,
	id: string,
	actor: Actor,
	reason: string | null
): Promise<{ email: string } | null> {
	return withTransaction(async (client) => {
		const { rows } = await client.query<{ email: string }>(
			`UPDATE access_request
			    SET status = 'denied', decided_at = now(), decided_by = $3,
			        deny_reason = $4, updated_at = now()
			  WHERE id = $1 AND group_id = $2 AND status = 'pending'
			RETURNING email::text AS email`,
			[id, group.id, actor.actorSubject ?? null, reason]
		);
		const req = rows[0];
		if (!req) return null;
		await auditIn(client, {
			...actor,
			category: 'authz',
			action: 'request.denied',
			groupId: group.id,
			groupSlug: group.slug,
			targetEmail: req.email,
			targetId: id,
			meta: reason ? { reason } : {}
		});
		return { email: req.email };
	});
}
