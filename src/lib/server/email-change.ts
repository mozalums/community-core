// A member's own sign-in address change: recent sign-in to ask, a link to the
// new address to prove it, a notice with an undo link to the old one. The
// identity rewrite itself is ./email-change-core.

import { query, withTransaction } from '$lib/server/postgres';
import {
	issueMagicToken,
	consumeMagicToken,
	isValidEmail,
	normalizeEmail,
	sendRateLimited
} from '$lib/server/magic-link';
import { deleteUserSessions, type SessionAuth } from '$lib/server/session-store';
import { PASSKEYS_ENABLED, reauthState } from '$lib/server/passkeys';
import { sendEmailChangeConfirm, sendEmailChangedNotice } from '$lib/server/email';
import { safeLocalPath } from '$lib/callback-path';
import { log } from '$lib/server/log';
import {
	addressTakenIn,
	confirmChangeIn,
	IdentityShifted,
	readIdentityIn,
	revertGrantIn,
	subjectFor,
	type Client
} from '$lib/server/email-change-core';

export const REVERT_TTL = 7 * 24 * 60 * 60;

export type RequestOutcome =
	| { ok: true }
	| { ok: false; reason: 'stale' | 'passkey' | 'invalid' | 'same' };

/**
 * Ask for a change from `current` to `next`. A taken or rate-limited address
 * answers exactly as a free one does and simply sends nothing, so the form
 * cannot be used to learn who is a member. Every awaited step runs on both
 * paths; minting the token and sending the link happen only on the free path,
 * so they run detached after the answer. A Redis write (an HTTP round trip on
 * Upstash) or an SMTP send awaited there would time the answer.
 */
export async function requestEmailChange(args: {
	session: { expiresAt?: number; auth?: SessionAuth } | null | undefined;
	memberId: string;
	current: string;
	next: string;
	origin: string;
	ip: string;
	returnTo: string;
}): Promise<RequestOutcome> {
	const db = { query } as unknown as Client;
	const current = normalizeEmail(args.current);
	const identity = await readIdentityIn(db, args.memberId);
	if (!identity || normalizeEmail(identity.email) !== current) return { ok: false, reason: 'stale' };
	const reauth = reauthState(args.session, PASSKEYS_ENABLED && identity.passkeys > 0);
	if (reauth !== 'ok') return { ok: false, reason: reauth };
	const next = normalizeEmail(args.next);
	if (!isValidEmail(next)) return { ok: false, reason: 'invalid' };
	if (next === current) return { ok: false, reason: 'same' };

	const limited = await sendRateLimited(next, args.ip);
	const taken = await addressTakenIn(db, next, identity.ids);
	if (limited || taken) {
		log.info('auth.email-change.requested', { memberId: args.memberId, sent: false });
		return { ok: true };
	}

	void issueMagicToken({
		purpose: 'email-change',
		email: next,
		from: current,
		memberId: args.memberId,
		epoch: identity.epoch,
		callbackUrl: safeLocalPath(args.returnTo)
	})
		.then((token) =>
			sendEmailChangeConfirm({ toEmail: next, url: `${args.origin}/auth/email?token=${token}` })
		)
		.catch((e) =>
			log.error('auth.email-change.send-failed', { memberId: args.memberId, error: e as Error })
		);
	log.info('auth.email-change.requested', { memberId: args.memberId, sent: true });
	return { ok: true };
}

// A membership added between reading an account and locking its groups is
// rare, and a rerun sees it.
async function inIdentityTransaction<T>(fn: (c: Client) => Promise<T>): Promise<T> {
	for (let attempt = 1; ; attempt++) {
		try {
			return await withTransaction((c) => fn(c as unknown as Client));
		} catch (e) {
			if (!(e instanceof IdentityShifted) || attempt >= 3) throw e;
		}
	}
}

export type ConfirmOutcome =
	| { ok: true; email: string; callbackUrl: string }
	| { ok: false; reason: 'token' | 'gone' | 'taken' };

/**
 * Spend an email-change token and move the account it was requested for. The
 * caller mints the new session; every session under the old subject is gone
 * by the time this returns, and the old address has its notice.
 */
export async function confirmEmailChange(token: string, origin: string): Promise<ConfirmOutcome> {
	const payload = await consumeMagicToken(token, 'email-change');
	if (!payload?.from || !payload.memberId || !payload.epoch) return { ok: false, reason: 'token' };
	const { from, memberId, epoch } = payload;
	const to = payload.email;

	const moved = await inIdentityTransaction((c) =>
		confirmChangeIn(c, { memberId, epoch, from, to, revertTtlSeconds: REVERT_TTL })
	);
	if (!moved.ok) {
		log.warn('auth.email-change.refused', { reason: moved.reason });
		return moved;
	}
	for (const old of moved.from) await deleteUserSessions(subjectFor(old));

	// After the commit, so a notice never announces a change that rolled back.
	// A failed send is logged loudly and does not undo the change: the new
	// address is proven, and the audit row records what happened.
	const revert = await issueMagicToken(
		{ purpose: 'email-revert', email: from, grant: moved.grant, callbackUrl: '/' },
		REVERT_TTL
	);
	try {
		await sendEmailChangedNotice({
			toEmail: from,
			newEmail: to,
			revertUrl: `${origin}/auth/email?token=${revert}`
		});
	} catch (e) {
		log.error('auth.email-change.notice-failed', { memberIds: moved.memberIds, error: e as Error });
	}
	log.info('auth.email-change.confirmed', { memberIds: moved.memberIds });
	return { ok: true, email: to, callbackUrl: payload.callbackUrl };
}

export type RevertOutcome = { ok: true } | { ok: false; reason: 'token' | 'gone' | 'taken' };

/**
 * Spend a revert token: the account goes back to the address the notice went
 * to, wherever it has moved since, every session on every address involved
 * ends, and its passkeys go with them.
 */
export async function revertEmailChange(token: string): Promise<RevertOutcome> {
	const payload = await consumeMagicToken(token, 'email-revert');
	if (!payload?.grant) return { ok: false, reason: 'token' };
	const grant = payload.grant;
	const to = payload.email;

	const moved = await inIdentityTransaction((c) => revertGrantIn(c, grant));
	if (!moved.ok) {
		log.warn('auth.email-revert.refused', { reason: moved.reason });
		return moved;
	}
	for (const addr of new Set([normalizeEmail(to), ...moved.from])) {
		await deleteUserSessions(subjectFor(addr));
	}
	log.info('auth.email-revert.confirmed', { memberIds: moved.memberIds });
	return { ok: true };
}
