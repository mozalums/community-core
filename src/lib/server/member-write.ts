// member-write-core.ts bound to the app's pool. Each entry point is one
// transaction; createMemberIn joins the caller's, because approval decides the
// request and creates the member in one commit.
//
// process.env rather than $env/dynamic/private keeps this loadable by the
// Postgres test fixtures outside Vite; adapter-node fills the latter from the
// former.

import { query, withTransaction } from '$lib/server/postgres';
import { recordPrivateValuesFrom } from '$lib/server/audit-core';
import { log } from '$lib/server/log';
import {
	bindSubjectIn,
	createMemberIn as createCore,
	hardPurgeMemberIn,
	softRemoveMemberIn,
	updateMemberIn,
	type Actor,
	type Authority,
	type BindInput,
	type Client,
	type CreateInput,
	type GroupRef,
	type Patch
} from '$lib/server/member-write-core';

export {
	MemberWriteError,
	setUsernameIn,
	type Authority,
	type Patch
} from '$lib/server/member-write-core';

const privateValues = () => recordPrivateValuesFrom(process.env);

export function updateMember(
	group: GroupRef,
	memberId: string,
	patch: Patch,
	actor: Actor,
	authority: Authority,
	opts: {
		writer?: 'form' | 'system';
		allow?: readonly string[];
		// More writes to commit or roll back with this one, run after it.
		also?: (client: Client) => Promise<unknown>;
	} = {}
): Promise<number> {
	return withTransaction(async (client) => {
		const changed = await updateMemberIn(client, {
			group,
			memberId,
			patch,
			actor,
			authority,
			writer: opts.writer ?? 'form',
			allow: opts.allow,
			recordPrivateValues: privateValues()
		});
		await opts.also?.(client);
		return changed;
	});
}

export function createMemberIn(
	client: Client,
	input: Omit<CreateInput, 'recordPrivateValues'>
): Promise<string | null> {
	return createCore(client, { ...input, recordPrivateValues: privateValues() });
}

export function bindSubject(input: BindInput): Promise<boolean> {
	return withTransaction((client) => bindSubjectIn(client, input));
}

export function softRemoveMember(group: GroupRef, memberId: string, actor: Actor) {
	return withTransaction((client) => softRemoveMemberIn(client, { group, memberId, actor }));
}

// `starrer` also clears the stars this member made, which have no foreign key.
// That runs after commit and is logged on failure: a leftover star by a
// deleted address grants nothing.
export async function hardPurgeMember(
	group: GroupRef,
	memberId: string,
	actor: Actor,
	starrer?: string | null
): Promise<boolean> {
	const purged = await withTransaction((client) =>
		hardPurgeMemberIn(client, { group, memberId, actor })
	);
	if (starrer) {
		await query(`DELETE FROM member_star WHERE group_id = $1 AND starrer = $2`, [
			group.id,
			starrer
		]).catch((e) =>
			log.warn('member-delete.stars-failed', { groupId: group.id, error: e as Error })
		);
	}
	return purged;
}
