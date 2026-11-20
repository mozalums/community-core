import { createHash } from 'node:crypto';

const STACK_MAX = 2000;
const REDACT_DEPTH_MAX = 6;

export function normalizeKey(key: string): string {
	return key.replace(/[_-]/g, '').toLowerCase();
}

// Context keys whose values are credentials — anything a holder can present to
// gain access with no second factor — plus member addresses, which present
// nothing and are still the fact this directory exists to protect. Redaction
// lives here rather than at the call sites because the call site that leaks is
// always the one written next, by someone debugging the very subsystem that owns
// the secret. The logger and the audit trail both import this one set, so a key
// added for either sink is covered in the other.
//
// Written in the form the code uses; matched with `_`/`-` stripped and case
// folded, so `sessionId`, `session_id` and `SESSION-ID` are one entry.
export const DENIED_KEYS = new Set(
	[
		'sessionId',
		'sid',
		'community_session',
		// The session cookie's name before it became SESSION_COOKIE_NAME. Browsers
		// that signed in under it still send it.
		'_lorem_s',
		'cookie',
		'authorization',
		'token',
		'magicToken',
		'accessToken',
		'idToken',
		'refreshToken',
		'MAILGUN_PRIVATE',
		'mailgunKey',
		'apiKey',
		'secret',
		// Normalisation strips `_`/`-` but does not split words, so a prefixed key
		// is its own entry: `SMTP_PASSWORD` folds to `smtppassword`, which the bare
		// `password` entry does not cover.
		'password',
		'SMTP_PASSWORD',
		'GOOGLE_SA_KEY',
		'GOOGLE_SA_PRIVATE_KEY',
		'privateKey',
		// Two of the sites that log an address sit on the sign-in path, so a
		// plaintext stream reconstructs the roster and who signed in when. The
		// digest keeps the property the field was there for: following one person
		// across events. `email.ts` spells the same value three other ways, and
		// folding does not split words, so each spelling is its own entry.
		'email',
		'toEmail',
		'fromEmail',
		'requesterEmail',
		// The session subject is `email:<addr>` (magic-link.ts), so it is an address
		// wearing another name and `auth.session.loaded` was writing it in clear.
		// Its digest covers a different string than the bare address, so the two
		// never match for one person; correlate within a field, not across them.
		// `email.ts` also calls a mail subject line `subject`. Nothing logs one
		// today, and over-redacting one if something ever does is the harmless
		// direction for this list to be wrong in.
		'subject'
	].map(normalizeKey)
);

// For a key whose name is configuration rather than code: session-store.ts
// registers whatever SESSION_COOKIE_NAME resolved to.
export function denyKey(key: string): void {
	DENIED_KEYS.add(normalizeKey(key));
}

// A digest of the credential, never the credential. sha256 is one-way and the
// retained 48 bits are far short of the 122 in a session UUID or the 256 in a
// magic-link token, so nothing here reconstructs a value `getSession` accepts —
// and the digest itself is not a key Redis holds. Unsalted on purpose: a
// per-process salt would break correlation across container restarts, which is
// the only reason to retain anything at all.
export function digest(value: unknown): string {
	const raw = typeof value === 'string' ? value : JSON.stringify(value);
	return `sha256:${createHash('sha256').update(String(raw)).digest('hex').slice(0, 12)}`;
}

// `seen` tracks the current path, not every object visited, so a value repeated
// across siblings still renders — only a genuine cycle becomes '[circular]'.
export function redactValue(
	key: string,
	value: unknown,
	depth: number,
	seen: Set<object>
): unknown {
	if (value != null && DENIED_KEYS.has(normalizeKey(key))) return digest(value);
	if (value instanceof Error) {
		return { message: value.message, stack: value.stack?.slice(0, STACK_MAX) };
	}
	if (value === null || typeof value !== 'object') return value;
	if (seen.has(value)) return '[circular]';
	if (depth >= REDACT_DEPTH_MAX) return '[truncated]';

	seen.add(value);
	const out = Array.isArray(value)
		? value.map((v, i) => redactValue(String(i), v, depth + 1, seen))
		: Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([k, v]) => [
					k,
					redactValue(k, v, depth + 1, seen)
				])
			);
	seen.delete(value);
	return out;
}

// Redact every value of a context object, the way the logger flattens one.
export function redactRecord(ctx: Record<string, unknown>): Record<string, unknown> {
	const seen = new Set<object>();
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(ctx)) {
		out[k] = redactValue(k, v, 1, seen);
	}
	return out;
}
