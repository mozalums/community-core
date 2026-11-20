import crypto from 'node:crypto';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { APP_APEX_DOMAIN } from '$lib/site';
import { denyKey } from './redact';
import { redis } from './redis';
import { SESSION_TTL, sessionExpired } from './session-lifetime';
import { GATE_COOKIE_NAME } from './site-gate';

const PREFIX = (env.LOREM_REDIS_PREFIX || 'lorem-prod').replace(/:$/, '');
const SESSION_PREFIX = `${PREFIX}:session:`;
const REFRESH_PREFIX = `${PREFIX}:refresh:`;
const REFRESH_LOCK_PREFIX = `${PREFIX}:refresh-lock:`;
const USER_SESSIONS_PREFIX = `${PREFIX}:usersessions:`;

export { SESSION_TTL }; // decided in ./session-lifetime
const REFRESH_LOCK_TTL = 30; // seconds

export const DEFAULT_SESSION_COOKIE_NAME = 'community_session';

// The marketing hook's two cookies. They are host-only where the session
// cookie is apex-scoped, so a session under either name would reach the server
// as a second cookie of the same name, and the hook would read whichever the
// browser listed first.
export const UTM_COOKIE_NAME = 'community_utm';
export const COHORT_COOKIE_NAME = 'community_cohort';

const RESERVED_COOKIE_NAMES: ReadonlyMap<string, string> = new Map([
	[GATE_COOKIE_NAME, 'the site gate'],
	[UTM_COOKIE_NAME, 'the marketing hook'],
	[COHORT_COOKIE_NAME, 'the marketing hook']
]);

// RFC 6265 takes a cookie name to be an RFC 2616 token: visible ASCII with no
// separators.
const COOKIE_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Reads SESSION_COOKIE_NAME. The cookie is scoped to the apex, so two
 * deployments under one apex that share a name are sent each other's cookie
 * and each looks a foreign id up in its own Redis.
 *
 * Throws rather than falling back, as `parseGateConfig` does: a browser drops
 * a `Set-Cookie` it considers invalid without telling the server, so a bad
 * name would otherwise surface as sign-in looping with nothing in the log.
 *
 * Only an absent variable takes the default, and the value is never trimmed. A
 * blank or padded line in a second deployment's env file is a name somebody
 * meant to set, and repairing it to the default is the collision the variable
 * exists to prevent.
 */
export function parseSessionCookieName(env: Record<string, string | undefined>): string {
	const name = env.SESSION_COOKIE_NAME;
	if (name === undefined) return DEFAULT_SESSION_COOKIE_NAME;
	if (!COOKIE_TOKEN.test(name)) {
		throw new Error(
			`SESSION_COOKIE_NAME must be an RFC 6265 cookie token (letters, digits and !#$%&'*+-.^_\`|~, with no spaces or blank value), got ${JSON.stringify(name)}. Remove the variable to use '${DEFAULT_SESSION_COOKIE_NAME}'`
		);
	}
	// Browsers match the prefix without regard to case.
	if (/^__Host-/i.test(name)) {
		throw new Error(
			`SESSION_COOKIE_NAME must not begin with '__Host-': the session cookie carries a Domain attribute, which that prefix forbids, so browsers would drop it. Got '${name}'`
		);
	}
	const holder = RESERVED_COOKIE_NAMES.get(name);
	if (holder) {
		throw new Error(
			`SESSION_COOKIE_NAME must not be '${name}': ${holder} already uses that cookie name`
		);
	}
	return name;
}

export const SESSION_COOKIE_NAME = parseSessionCookieName(env);

// A log or audit context keyed by the cookie's own name holds the session id.
denyKey(SESSION_COOKIE_NAME);

// Scoped to the apex domain so every subdomain (moz.<apex>, www.<apex>) shares
// the session. Deleting the cookie must use these same options — pass this
// object to cookies.delete too, or the domain won't match and it survives.
export const SESSION_COOKIE_OPTIONS = {
	path: '/',
	httpOnly: true,
	secure: !dev,
	sameSite: 'lax' as const,
	...(dev ? {} : { domain: `.${APP_APEX_DOMAIN}` })
};

export type SessionUser = {
	id: string;
	subject: string;
	email: string;
	name: string;
	image: string;
};

export type SessionData = {
	user: SessionUser;
	accessToken: string;
	idToken: string;
	expiresAt: number;
	profile: Record<string, unknown>;
};

export function generateSessionId(): string {
	return crypto.randomUUID();
}

export async function createSession(data: SessionData): Promise<string> {
	const sessionId = generateSessionId();
	await redis.set(`${SESSION_PREFIX}${sessionId}`, data, { ex: SESSION_TTL });
	// Index the session under its subject so every session for a user can be
	// revoked at once (e.g. when an admin denies their membership request).
	const subject = data.user?.subject;
	if (subject) {
		const idx = `${USER_SESSIONS_PREFIX}${subject}`;
		await redis.sadd(idx, sessionId);
		await redis.expire(idx, SESSION_TTL);
	}
	return sessionId;
}

export async function getSession(
	sessionId: string | null | undefined
): Promise<SessionData | null> {
	if (!sessionId) return null;
	const session = (await redis.get(`${SESSION_PREFIX}${sessionId}`)) as SessionData | null;
	if (!session) return null;
	if (sessionExpired(session)) {
		await deleteSession(sessionId);
		return null;
	}
	return session;
}

export async function updateSession(sessionId: string, data: SessionData): Promise<void> {
	await redis.set(`${SESSION_PREFIX}${sessionId}`, data, { ex: SESSION_TTL });
}

export async function deleteSession(sessionId: string): Promise<void> {
	await Promise.all([
		redis.del(`${SESSION_PREFIX}${sessionId}`),
		redis.del(`${REFRESH_PREFIX}${sessionId}`)
	]);
}

// Revoke every session for a subject (email:<addr>) — used when a membership
// request is denied, to sign that person out. Returns the count found in the
// index. Only sessions created after this indexing shipped are covered; older
// ones simply lapse at their TTL.
export async function deleteUserSessions(subject: string): Promise<number> {
	const idx = `${USER_SESSIONS_PREFIX}${subject}`;
	const ids = ((await redis.smembers(idx)) as string[]) ?? [];
	const keys = ids.flatMap((id) => [`${SESSION_PREFIX}${id}`, `${REFRESH_PREFIX}${id}`]);
	if (keys.length) await redis.del(...keys);
	await redis.del(idx);
	return ids.length;
}

export async function setRefreshToken(sessionId: string, refreshToken: string): Promise<void> {
	await redis.set(`${REFRESH_PREFIX}${sessionId}`, refreshToken, { ex: SESSION_TTL });
}

export async function getRefreshToken(
	sessionId: string | null | undefined
): Promise<string | null> {
	if (!sessionId) return null;
	const token = (await redis.get(`${REFRESH_PREFIX}${sessionId}`)) as string | null;
	return token || null;
}

export async function getSessionAndRefreshToken(
	sessionId: string | null | undefined
): Promise<{ session: SessionData | null; refreshToken: string | null }> {
	if (!sessionId) return { session: null, refreshToken: null };
	const pipeline = redis.pipeline();
	pipeline.get(`${SESSION_PREFIX}${sessionId}`);
	pipeline.get(`${REFRESH_PREFIX}${sessionId}`);
	const [session, refreshToken] = (await pipeline.exec()) as [SessionData | null, string | null];
	if (sessionExpired(session)) {
		await deleteSession(sessionId);
		return { session: null, refreshToken: null };
	}
	return { session, refreshToken: refreshToken || null };
}

export async function updateSessionAndRefreshToken(
	sessionId: string,
	session: SessionData,
	refreshToken: string | null
): Promise<void> {
	const pipeline = redis.pipeline();
	pipeline.set(`${SESSION_PREFIX}${sessionId}`, session, { ex: SESSION_TTL });
	if (refreshToken) {
		pipeline.set(`${REFRESH_PREFIX}${sessionId}`, refreshToken, { ex: SESSION_TTL });
	}
	await pipeline.exec();
}

// Mutex so concurrent requests on the same session don't all try to refresh
// the access token at once.
export async function acquireRefreshLock(sessionId: string): Promise<boolean> {
	const result = await redis.set(`${REFRESH_LOCK_PREFIX}${sessionId}`, '1', {
		nx: true,
		ex: REFRESH_LOCK_TTL
	});
	return result === 'OK';
}

export async function releaseRefreshLock(sessionId: string): Promise<void> {
	await redis.del(`${REFRESH_LOCK_PREFIX}${sessionId}`);
}
