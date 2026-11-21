// Self-hosted passwordless magic-link auth. Replaces a hosted OIDC flow:
// we mint a single-use, hashed-at-rest token in Redis, email a sign-in link (see
// mail.ts), and on confirmation mint our own session for the verified
// email. The session subject is `email:<addr>` — the exact form the old OIDC flow
// produced — so member/admin resolution is unchanged.

import crypto from 'node:crypto';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { redis } from '$lib/server/redis';
import { hashId, rateLimitKey, rateLimited } from '$lib/server/rate-limit';
import { createSession, type SessionAuth, type SessionData } from '$lib/server/session-store';
import { sessionExpiresAt } from '$lib/server/session-lifetime';
import { mailConfigured } from '$lib/server/mail';
import { sendMagicLinkEmail } from '$lib/server/email';
import { destForLog, safeLocalPath } from '$lib/callback-path';
import { log } from '$lib/server/log';
import { isValidEmail, normalizeEmail } from '$lib/server/email-change-core';

const PREFIX = (env.LOREM_REDIS_PREFIX || 'lorem-prod').replace(/:$/, '');
const magicKey = (hash: string) => `${PREFIX}:magic:${hash}`;

const TOKEN_TTL = 30 * 60; // 30 minutes, matching the Auth.js link we replace

// Rate limits, per rolling window. The token is 256-bit and single-use, so there
// is no guessing surface — these caps only exist to prevent email bombing / abuse
// of our sending domain.
const RL_WINDOW = 15 * 60; // 15 minutes
const RL_EMAIL_MAX = 5;
const RL_IP_MAX = 20;

// What a token is good for. One key space and one link format serve all three,
// so the purpose rides in the payload and every consumer names the one it
// accepts: a sign-in link must never confirm an address change, and a change
// link must never sign anyone in.
export type MagicPurpose = 'sign-in' | 'email-change' | 'email-revert';

export type MagicPayload = {
	email: string;
	callbackUrl: string;
	/** Absent on tokens minted before purposes existed, which were all sign-ins. */
	purpose?: MagicPurpose;
	/** email-change: the address being replaced. */
	from?: string;
	/** email-change: the requesting member row and its identity_epoch then. */
	memberId?: string;
	epoch?: string;
	/** email-revert: the email_revert_grant row it spends. */
	grant?: string;
};

const purposeOf = (p: MagicPayload): MagicPurpose => p.purpose ?? 'sign-in';

/**
 * The per-IP sign-in cap. Every sign-in method spends the same counter, so a
 * second method does not double what one address may attempt.
 */
export function signInRateLimited(ip: string): Promise<boolean> {
	return rateLimited(rateLimitKey('magic-rl:ip', ip), RL_IP_MAX, RL_WINDOW);
}

/**
 * The per-address and per-IP send caps every emailed link spends, whatever its
 * purpose, so a second kind of link does not double what one caller may send.
 * Both counters are spent before either is read, as they always were.
 */
export async function sendRateLimited(email: string, ip: string): Promise<boolean> {
	const emailRl = await rateLimited(
		rateLimitKey('magic-rl:e', hashId(email)),
		RL_EMAIL_MAX,
		RL_WINDOW
	);
	const ipRl = await signInRateLimited(ip);
	if (emailRl || ipRl) log.warn('auth.magic.rate-limited', { emailRl, ipRl });
	return emailRl || ipRl;
}

/**
 * Store a single-use token's hash with its payload and return the raw token,
 * which exists nowhere else but the link it goes into. Sign-in and email-change
 * links live 30 minutes; a revert link is given its own lifetime.
 */
export async function issueMagicToken(
	payload: MagicPayload,
	ttlSeconds: number = TOKEN_TTL
): Promise<string> {
	const token = crypto.randomBytes(32).toString('base64url');
	await redis.set(magicKey(sha256(token)), payload, { ex: ttlSeconds });
	return token;
}

function sha256(s: string): string {
	return crypto.createHash('sha256').update(s).digest('hex');
}

// Defined beside the identity rewrite, which the operator script runs outside Vite.
export { isValidEmail, normalizeEmail } from '$lib/server/email-change-core';

/**
 * Generate a single-use magic-link token, store its hash in Redis, and email the
 * link. Resolves generically — `ok:false` only for a malformed or rate-limited
 * request, never revealing whether the address exists or is a member.
 */
export async function sendMagicLink(args: {
	email: string;
	callbackUrl?: string | null;
	origin: string;
	ip: string;
}): Promise<{ ok: boolean; reason?: 'invalid' | 'rate_limited' }> {
	const email = normalizeEmail(args.email);
	if (!isValidEmail(email)) return { ok: false, reason: 'invalid' };

	const requested = args.callbackUrl ?? null;
	const callbackUrl = safeLocalPath(requested);

	if (await sendRateLimited(email, args.ip)) return { ok: false, reason: 'rate_limited' };

	const token = await issueMagicToken({ email, callbackUrl, purpose: 'sign-in' });
	const url = `${args.origin}/auth/magic?token=${token}`;
	if (dev && !mailConfigured()) {
		// Only the hash reaches Redis, so with no mail credentials there is no way
		// back to the link and local sign-in is impossible. `dev` is a compile-time
		// constant: this branch is not in a production build, where missing
		// credentials still fail loudly.
		log.warn('auth.magic.dev-link', { url });
	} else {
		await sendMagicLinkEmail({ toEmail: email, url });
	}
	// `defaulted` separates "no origin was captured" from "the origin was the
	// default page". Without it a resend, whose destination died with the token,
	// is indistinguishable in the log from a member who signed in from /members.
	log.info('auth.magic.sent', {
		email,
		dest: destForLog(callbackUrl),
		defaulted: callbackUrl !== requested
	});
	return { ok: true };
}

// Look up without consuming — for the interstitial confirmation page's load. A
// token minted for another purpose reads as absent.
export async function peekMagicToken(
	token: string | null | undefined,
	purpose: MagicPurpose = 'sign-in'
): Promise<MagicPayload | null> {
	if (!token) return null;
	const payload = ((await redis.get(magicKey(sha256(token)))) as MagicPayload | null) ?? null;
	return payload && purposeOf(payload) === purpose ? payload : null;
}

// Atomically consume (single-use) — for the confirm POST. The purpose is checked
// on a peek first, so presenting a token at the wrong door refuses it without
// spending it: the link still works where it was meant to.
export async function consumeMagicToken(
	token: string | null | undefined,
	purpose: MagicPurpose = 'sign-in'
): Promise<MagicPayload | null> {
	if (!(await peekMagicToken(token, purpose))) return null;
	const payload = ((await redis.getdel(magicKey(sha256(token!)))) as MagicPayload | null) ?? null;
	return payload && purposeOf(payload) === purpose ? payload : null;
}

// Mint a token-less lorem.host session for a verified email. `method` is how
// it was verified, which decides whether the session may change the address.
export async function mintEmailSession(
	email: string,
	method: SessionAuth['method']
): Promise<string> {
	const subject = `email:${email}`;
	const data: SessionData = {
		user: { id: subject, subject, email, name: '', image: '' },
		accessToken: '',
		idToken: '',
		expiresAt: sessionExpiresAt(),
		profile: {},
		auth: { method, at: Date.now() }
	};
	return createSession(data);
}
