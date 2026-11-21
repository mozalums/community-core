// Passkeys sit beside the magic link, which stays the way to enroll and to
// recover. A passkey belongs to a member row, and a verified sign-in mints the
// same session the magic link does, for that member's current address. The
// ceremonies live in ./passkey-store.

import { auth } from '$skin/skin.yaml';
import { SESSION_TTL } from '$lib/server/session-lifetime';
import type { SessionAuth } from '$lib/server/session-store';

/** On unless the skin says `auth.passkeys: false`. */
export const PASSKEYS_ENABLED = auth?.passkeys !== false;

// A credential that signs in with no email is a takeover path for anyone
// holding a stolen session cookie, so adding one needs proof the member was
// here a moment ago: a session minted in the last ten minutes.
export const FRESH_SESSION_MS = 10 * 60 * 1000;

/** Sessions are absolute, so their mint time is the expiry minus the lifetime. */
export function sessionIsFresh(
	session: { expiresAt?: number } | null | undefined,
	now: number = Date.now()
): boolean {
	if (!session?.expiresAt) return false;
	return session.expiresAt - SESSION_TTL * 1000 >= now - FRESH_SESSION_MS;
}

/**
 * Whether a session may change its sign-in address now. An identity with a
 * usable passkey must have used one in the last ten minutes: a magic link
 * reaches whoever reads the mailbox, and a passkey is the stronger proof the
 * member already chose. Without one, any fresh sign-in will do.
 */
export function reauthState(
	session: { expiresAt?: number; auth?: SessionAuth } | null | undefined,
	passkeyRequired: boolean,
	now: number = Date.now()
): 'ok' | 'stale' | 'passkey' {
	if (!passkeyRequired) return sessionIsFresh(session, now) ? 'ok' : 'stale';
	const auth = session?.auth;
	return auth?.method === 'passkey' && auth.at >= now - FRESH_SESSION_MS ? 'ok' : 'passkey';
}

export type PasskeySummary = {
	id: string;
	nickname: string;
	createdAt: string;
	lastUsedAt: string | null;
};
