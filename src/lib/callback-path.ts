// Post-sign-in destination policy. Lives apart from magic-link.ts because that
// module imports `$app/environment`, which the test runner cannot resolve — and
// these three are the parts with rules worth pinning.
//
// Universal, not under $lib/server: the group landing page validates `?next=`
// in the browser, and SvelteKit refuses a $lib/server import there. Keep it free
// of $env, $app and node: imports, or that page stops building.

// Where a member lands when no origin was captured, or when the one offered was
// rejected below.
export const DEFAULT_DEST = '/members';

// Only allow same-origin, non-protocol-relative paths as a post-login destination
// so a tampered callbackUrl can't become an open redirect.
export function safeLocalPath(cb: string | null | undefined, fallback = DEFAULT_DEST): string {
	if (!cb || typeof cb !== 'string') return fallback;
	if (!cb.startsWith('/')) return fallback;
	if (cb.startsWith('//') || cb.startsWith('/\\')) return fallback;
	return cb;
}

// The destination is a visitor-supplied path, so its query string is
// visitor-supplied too and a live magic-link token is a legal thing to put
// there. Only the pathname answers the question the log line exists to answer —
// did this member land on the default page or deep-link — so only the pathname
// is emitted. The base is a placeholder: `safeLocalPath` has already guaranteed
// a leading slash, so nothing of it survives into the result.
export function destForLog(dest: string): string {
	return new URL(dest, 'https://callback.invalid').pathname;
}
