import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, mock, test } from 'node:test';
import pg from 'pg';
import sharp from 'sharp';

// The photo URL written into the member's avatar field is /avatar/<public id>,
// recorded once and never rewritten when the photo is replaced. That holds only
// if replacing the bytes leaves the id alone, which is a property of the upsert
// in putAvatar, so it is checked against Postgres rather than a stub.
//
//   AUDIT_TEST_DATABASE_URL=postgres://… pnpm test
const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const pool = url ? new pg.Pool({ connectionString: url, max: 3 }) : null;

mock.module('$lib/server/postgres', {
	namedExports: {
		pgPool: () => pool,
		query: (text: string, values?: unknown[]) => pool!.query(text, values)
	}
});

const { migrate } = await import('./migrations');
const { putAvatar, getAvatarByPublicId } = await import('./avatars');
const { normalizeAvatar } = await import('./avatar-image');

const EMAIL = `b22-${randomBytes(4).toString('hex')}@example.org`;

before(async () => {
	if (pool) await migrate(pool);
});

after(async () => {
	await pool?.query('DELETE FROM member_avatar WHERE email = $1', [EMAIL]);
	await pool?.end();
});

async function reencoded(type: 'png' | 'jpeg', edge: number) {
	const raw = await sharp({
		create: { width: edge, height: edge, channels: 3, background: { r: 9, g: 99, b: 199 } }
	})
		[type]()
		.toBuffer();
	const out = await normalizeAvatar(raw, `image/${type}`, 2 * 1024 * 1024);
	assert.ok(out.ok);
	return out;
}

test(
	'B22.3: replacing a re-encoded photo keeps the public id, and the id serves the new bytes',
	opts,
	async () => {
		const first = await reencoded('png', 64);
		const id = await putAvatar(EMAIL, first.bytes, first.contentType);

		const second = await reencoded('jpeg', 32);
		const again = await putAvatar(EMAIL, second.bytes, second.contentType);
		assert.equal(again, id, 'replacing the photo moved the URL the member field records');

		const row = await getAvatarByPublicId(id);
		assert.equal(row?.contentType, 'image/jpeg');
		assert.deepEqual(Buffer.from(row!.bytes!), second.bytes);
	}
);
