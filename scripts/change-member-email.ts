// Operator recovery for a member who has lost both their sign-in address and
// the one they changed from, so neither the change flow nor its undo link can
// reach them. Moves the identity the same way a member's own change does,
// removes their passkeys and voids their outstanding undo links, since whoever
// holds the lost address may have enrolled one or hold those.
//
//   deploy/run.sh change-member-email <current-address> <new-address>
//
// Postgres only. Sessions under the old address stay in Redis until their
// 24-hour lifetime ends, but no member row or admin grant answers to that
// address any more, so they reach nothing a guest cannot.
import {
	IdentityShifted,
	isValidEmail,
	normalizeEmail,
	recoverIdentityIn,
	type Client
} from '../src/lib/server/email-change-core';
import { scriptPool } from './db';

async function main(): Promise<number> {
	const [rawFrom, rawTo] = process.argv.slice(2);
	if (!rawFrom || !rawTo) {
		console.error('usage: change-member-email <current-address> <new-address>');
		return 2;
	}
	const from = normalizeEmail(rawFrom);
	const to = normalizeEmail(rawTo);
	if (!isValidEmail(to) || from === to) {
		console.error(`change-member-email: '${rawTo}' is not a different, valid address`);
		return 2;
	}

	const pool = scriptPool();
	const client = await pool.connect();
	try {
		await client.query('BEGIN');
		const moved = await recoverIdentityIn(client as unknown as Client, from, to);
		if (!moved.ok) {
			await client.query('ROLLBACK');
			console.error(
				moved.reason === 'gone'
					? `change-member-email: no member has the address ${from}`
					: `change-member-email: ${to} already belongs to a member or an admin`
			);
			return 1;
		}
		await client.query('COMMIT');
		console.log(
			`change-member-email: ${moved.memberIds.length} member row(s) now sign in as ${to}; passkeys removed`
		);
		return 0;
	} catch (e) {
		await client.query('ROLLBACK').catch(() => {});
		if (e instanceof IdentityShifted) {
			console.error(`change-member-email: ${e.message}`);
			return 1;
		}
		throw e;
	} finally {
		client.release();
		await pool.end();
	}
}

main()
	.then((code) => process.exit(code))
	.catch((e) => {
		console.error('[change-member-email] failed:', e);
		process.exit(1);
	});
