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
import { createSession, type SessionData } from '$lib/server/session-store';
import { sessionExpiresAt } from '$lib/server/session-lifetime';
import { mailConfigured } from '$lib/server/mail';
import { sendMagicLinkEmail } from '$lib/server/email';
import { destForLog, safeLocalPath } from '$lib/callback-path';
import { log } from '$lib/server/log';

const PREFIX = (env.LOREM_REDIS_PREFIX || 'lorem-prod').replace(/:$/, '');
const magicKey = (hash: string) => `${PREFIX}:magic:${hash}`;

const TOKEN_TTL = 30 * 60; // 30 minutes, matching the Auth.js link we replace

// Rate limits, per rolling window. The token is 256-bit and single-use, so there
// is no guessing surface — these caps only exist to prevent email bombing / abuse
// of our sending domain.
const RL_WINDOW = 15 * 60; // 15 minutes
const RL_EMAIL_MAX = 5;
const RL_IP_MAX = 20;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type MagicPayload = { email: string; callbackUrl: string };

function sha256(s: string): string {
	return crypto.createHash('sha256').update(s).digest('hex');
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
	return EMAIL_RE.test(email);
}

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

	const emailRl = await rateLimited(
		rateLimitKey('magic-rl:e', hashId(email)),
		RL_EMAIL_MAX,
		RL_WINDOW
	);
	const ipRl = await rateLimited(rateLimitKey('magic-rl:ip', args.ip), RL_IP_MAX, RL_WINDOW);
	if (emailRl || ipRl) {
		log.warn('auth.magic.rate-limited', { emailRl, ipRl });
		return { ok: false, reason: 'rate_limited' };
	}

	const token = crypto.randomBytes(32).toString('base64url');
	const payload: MagicPayload = { email, callbackUrl };
	// Store the HASH — a Redis read never yields a usable token; the raw token
	// only exists in the emailed link.
	await redis.set(magicKey(sha256(token)), payload, { ex: TOKEN_TTL });

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

// Look up without consuming — for the interstitial confirmation page's load.
export async function peekMagicToken(
	token: string | null | undefined
): Promise<MagicPayload | null> {
	if (!token) return null;
	return ((await redis.get(magicKey(sha256(token)))) as MagicPayload | null) ?? null;
}

// Atomically consume (single-use) — for the confirm POST.
export async function consumeMagicToken(
	token: string | null | undefined
): Promise<MagicPayload | null> {
	if (!token) return null;
	return ((await redis.getdel(magicKey(sha256(token)))) as MagicPayload | null) ?? null;
}

// Mint a token-less lorem.host session for a verified email.
export async function mintEmailSession(email: string): Promise<string> {
	const subject = `email:${email}`;
	const data: SessionData = {
		user: { id: subject, subject, email, name: '', image: '' },
		accessToken: '',
		idToken: '',
		expiresAt: sessionExpiresAt(),
		profile: {}
	};
	return createSession(data);
}
