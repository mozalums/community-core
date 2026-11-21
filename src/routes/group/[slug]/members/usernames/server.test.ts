import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { isHttpError } from '@sveltejs/kit';

// The availability endpoint behind the edit page's Username input. The gate and
// the Redis counter are stubbed; usernameStatus and the rule are the real ones,
// over a member table of one current name (Ada's) and one retired name each.

const ADA = '00000000-0000-4000-8000-00000000000a';
const BOB = '00000000-0000-4000-8000-00000000000b';
const HELD: Record<string, { owner: string; current: boolean }[]> = {
	'ada-lovelace': [{ owner: ADA, current: true }],
	countess: [{ owner: ADA, current: false }],
	'bob-old': [{ owner: BOB, current: false }]
};
mock.module('$lib/server/postgres', {
	namedExports: {
		query: async (_text: string, values: unknown[]) => ({ rows: HELD[values[1] as string] ?? [] })
	}
});

type Caller = 'ada' | 'bob' | 'stranger' | 'guest';
mock.module('$lib/server/route-guards', {
	namedExports: {
		requireDirectoryAccess: async (_p: unknown, locals: { caller: Caller }) => {
			if (locals.caller === 'guest') throw Object.assign(new Error(), { status: 401 });
			if (locals.caller === 'stranger') throw Object.assign(new Error(), { status: 403 });
			return {
				group: { id: 'g' },
				user: { subject: locals.caller },
				member: { id: locals.caller === 'ada' ? ADA : BOB }
			};
		}
	}
});
const counts = new Map<string, number>();
mock.module('$lib/server/rate-limit', {
	namedExports: {
		hashId: (s: string) => `h(${s})`,
		rateLimitKey: (bucket: string, id: string) => `${bucket}:${id}`,
		rateLimited: async (key: string, max: number) => {
			counts.set(key, (counts.get(key) ?? 0) + 1);
			return counts.get(key)! > max;
		}
	}
});
mock.module('$lib/server/log', {
	namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } }
});

const { GET } = await import('./+server');

async function ask(name: string, caller: Caller = 'ada', sessionId = `sid-${caller}`) {
	try {
		const res = await GET({
			params: { slug: 'g' },
			locals: { caller, sessionId, user: { subject: caller } },
			url: new URL(`https://example.org/members/usernames?name=${encodeURIComponent(name)}`)
		} as never);
		return { status: res.status, body: await res.json() };
	} catch (e) {
		const status = (e as { status?: number }).status;
		if (isHttpError(e) || typeof status === 'number') return { status, body: null };
		throw e;
	}
}

test('F11 R3: the endpoint answers available, taken, not allowed, reserved and yours', async () => {
	assert.deepEqual((await ask('Grace-Hopper')).body, { status: 'available', name: 'grace-hopper' });
	assert.deepEqual((await ask('ada-lovelace')).body, { status: 'yours', name: 'ada-lovelace' });
	assert.deepEqual((await ask('ada-lovelace', 'bob')).body, {
		status: 'taken',
		name: 'ada-lovelace'
	});
	// A retired name is taken for everyone but its owner, who may take it back.
	assert.deepEqual((await ask('countess', 'bob')).body, { status: 'taken', name: 'countess' });
	assert.deepEqual((await ask('countess')).body, { status: 'available', name: 'countess' });
	const ascii = (await ask('аda')).body;
	assert.equal(ascii.status, 'invalid');
	assert.equal(ascii.rule, 'ascii');
	assert.match(ascii.message, /look-alike/);
	assert.equal((await ask('ab')).body.rule, 'length');
	assert.equal((await ask('logout')).body.status, 'reserved');
});

test('F11 R3: the endpoint applies the directory gate', async () => {
	assert.equal((await ask('grace', 'guest')).status, 401);
	assert.equal((await ask('ada-lovelace', 'stranger')).status, 403);
	assert.equal((await ask('no-such-name', 'stranger')).status, 403);
});

test('F11 R3: the endpoint is rate-limited per session', async () => {
	counts.clear();
	for (let i = 0; i < 60; i++) assert.equal((await ask('grace', 'bob', 'busy')).status, 200);
	const over = await ask('grace', 'bob', 'busy');
	assert.equal(over.status, 429);
	assert.equal(over.body.status, 'limited');
	assert.equal(
		(await ask('grace', 'bob', 'other-tab')).status,
		200,
		'the limit is not per session'
	);
	assert.ok([...counts.keys()].every((k) => k.startsWith('username-check:session:h(')));
});
