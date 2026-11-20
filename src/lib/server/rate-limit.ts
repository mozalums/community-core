// Fixed-window abuse counters in Redis, shared by every endpoint that spends
// somebody else's resource on an unauthenticated caller's behalf — a Mailgun
// send today, whatever comes next tomorrow. One counter shape, one place to
// change it.
//
// INCR then EXPIRE on the write that created the key: the window is fixed
// rather than rolling, so a caller straddling a boundary can spend up to 2x max
// before the ceiling bites. Accepted deliberately — these caps bound cost and
// sender reputation, not correctness, and a rolling window costs a sorted set
// and a ZREMRANGEBYSCORE per caller to buy an exactness nothing here needs.

import crypto from 'node:crypto';
import { redis } from '$lib/server/redis';

// process.env, not $env/dynamic/private: adapter-node populates the latter from
// the former, and reading it directly keeps this module loadable outside Vite,
// which is what lets the endpoints that depend on it be tested at all. The cost
// is that `vite dev` resolves .env into $env only, so a dev-only
// LOREM_REDIS_PREFIX namespaces the counters differently from the sessions
// beside them. That renames a key; it does not change a cap.
const PREFIX = (process.env.LOREM_REDIS_PREFIX || 'lorem-prod').replace(/:$/, '');

/** Namespaced counter key. Run `id` through `hashId` when it is PII. */
export function rateLimitKey(bucket: string, id: string): string {
	return `${PREFIX}:${bucket}:${id}`;
}

// Addresses key several buckets. Hashing keeps the plaintext out of Redis,
// where a keyspace dump would otherwise be a list of everyone who used the site.
export function hashId(value: string): string {
	return crypto.createHash('sha256').update(value).digest('hex');
}

/** True once this key has been spent more than `max` times in the window. */
export async function rateLimited(
	key: string,
	max: number,
	windowSeconds: number
): Promise<boolean> {
	const n = await redis.incr(key);
	if (n === 1) await redis.expire(key, windowSeconds);
	return n > max;
}
