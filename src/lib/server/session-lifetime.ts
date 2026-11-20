// Session lifetime, and the only expiry check this app runs itself: Redis drops
// the key at its TTL and the browser stops sending the cookie at its `Expires`,
// but a key that loses its TTL, or a client that ignores the cookie, passes both
// unchallenged. Separate from session-store.ts, which imports `$app/environment`
// and so cannot load under the test runner.

export const SESSION_TTL = 24 * 60 * 60; // seconds; multiplied out below

/** Deadline for a session minted at `now`. Absolute: activity never extends it. */
export function sessionExpiresAt(now: number = Date.now()): number {
	return now + SESSION_TTL * 1000;
}

/**
 * `expiresAt: 0` is not expired: it predates the stamp, and treating it as
 * expired would sign out everyone holding one at deploy time. Those lapse when
 * Redis drops the key, within SESSION_TTL.
 */
export function sessionExpired(
	session: { expiresAt?: number } | null | undefined,
	now: number = Date.now()
): boolean {
	if (!session?.expiresAt) return false;
	return session.expiresAt <= now;
}
