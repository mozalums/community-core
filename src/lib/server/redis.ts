// `@upstash/redis` speaks REST only, so with it as the sole client there is no
// offline path: every local session round-trips to a SaaS and a developer with no
// Upstash project cannot sign in at all. This module is the seam — a narrow
// interface over the operations the session store and the magic-link flow
// actually issue, with two backends behind it. Adding an operation means
// implementing it on both deliberately.
//
// The same seam is what lets a self-hosted deployment drop Upstash from the
// authentication path rather than paying a WAN round-trip, and an availability
// dependency, on every authenticated request. The deployment of record does
// that with `REDIS_URL=redis://redis:6379` — a service name on the compose
// network, not `127.0.0.1`, because the container's loopback is its own and
// reaches no Redis at all.

import { Redis } from '@upstash/redis';
import { createClient } from 'redis';
import { env } from '$env/dynamic/private';
import { log } from './log';

export type SetOptions = { ex?: number; nx?: boolean };

export type RedisPipeline = {
	get(key: string): RedisPipeline;
	set(key: string, value: unknown, opts?: SetOptions): RedisPipeline;
	exec(): Promise<unknown[]>;
};

export type RedisLike = {
	get(key: string): Promise<unknown>;
	set(key: string, value: unknown, opts?: SetOptions): Promise<'OK' | null>;
	del(...keys: string[]): Promise<unknown>;
	incr(key: string): Promise<number>;
	expire(key: string, seconds: number): Promise<unknown>;
	sadd(key: string, ...members: string[]): Promise<unknown>;
	smembers(key: string): Promise<string[]>;
	getdel(key: string): Promise<unknown>;
	pipeline(): RedisPipeline;
};

// Upstash serializes non-strings to JSON on write and attempts a parse on read.
// The RESP backend has to match, or a session written by one and read by the
// other comes back as a string of JSON. The asymmetry this leaves is a plain
// string that happens to parse as JSON: only refresh tokens are stored as bare
// strings, and those are opaque base64url.
function encode(value: unknown): string {
	return typeof value === 'string' ? value : JSON.stringify(value);
}

function decode(value: string | null): unknown {
	if (value === null) return null;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

// Neither call site needs atomicity — both batch independent keys purely to save
// round-trips, and Upstash's own `pipeline()` is not transactional either (that
// is `multi()`). node-redis pipelines concurrent commands on one connection, so
// dispatching together is the faithful equivalent, not a MULTI.
function pipelineOver(ops: Omit<RedisLike, 'pipeline'>): RedisPipeline {
	const queued: Array<() => Promise<unknown>> = [];
	const chain: RedisPipeline = {
		get(key) {
			queued.push(() => ops.get(key));
			return chain;
		},
		set(key, value, opts) {
			queued.push(() => ops.set(key, value, opts));
			return chain;
		},
		exec: () => Promise.all(queued.map((run) => run()))
	};
	return chain;
}

function respBackend(url: string): RedisLike {
	type Client = ReturnType<typeof createClient>;
	let conn: Promise<Client> | null = null;

	function client(): Promise<Client> {
		if (!conn) {
			const c = createClient({ url });
			// Without a listener an emitted 'error' takes the process down.
			c.on('error', (err) => log.error('redis.client-error', { error: err as Error }));
			conn = c.connect().then(() => c);
		}
		return conn;
	}

	const ops: Omit<RedisLike, 'pipeline'> = {
		async get(key) {
			return decode(await (await client()).get(key));
		},
		async set(key, value, opts) {
			const result = await (
				await client()
			).set(key, encode(value), {
				...(opts?.ex ? { EX: opts.ex } : {}),
				...(opts?.nx ? { NX: true } : {})
			});
			return result === 'OK' ? 'OK' : null;
		},
		async del(...keys) {
			if (!keys.length) return 0;
			return (await client()).del(keys);
		},
		async incr(key) {
			return (await client()).incr(key);
		},
		async expire(key, seconds) {
			return (await client()).expire(key, seconds);
		},
		async sadd(key, ...members) {
			return (await client()).sAdd(key, members);
		},
		async smembers(key) {
			return (await client()).sMembers(key);
		},
		async getdel(key) {
			return decode(await (await client()).getDel(key));
		}
	};

	return { ...ops, pipeline: () => pipelineOver(ops) };
}

function upstashBackend(url: string | undefined, token: string | undefined): RedisLike {
	if (!url || !token) {
		log.error('redis.config-missing', {
			need: 'REDIS_URL, or both UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN'
		});
	}
	// The Upstash client covers every operation in RedisLike but its generic
	// signatures do not line up structurally. This cast is the seam, and the
	// reason RedisLike lists only what the app calls.
	return new Redis({ url: url!, token: token! }) as unknown as RedisLike;
}

// REDIS_URL wins. Setting it is an explicit statement that this deployment runs
// its own Redis; preferring a leftover Upstash pair would put sessions somewhere
// the operator did not intend and would not notice.
export const redis: RedisLike = env.REDIS_URL
	? respBackend(env.REDIS_URL)
	: upstashBackend(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
