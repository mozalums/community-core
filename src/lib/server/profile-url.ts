// The one test a member-supplied URL passes before it is stored or handed to
// an `href`. Syntax and scheme only: nothing here fetches the address, because
// probing a member-chosen host from the server needs an SSRF guard at the
// dialer for a field a person can check by clicking it.

export const MAX_PROFILE_URL_LENGTH = 2048;

export type ProfileUrlCheck = { ok: true; url: string } | { ok: false; reason: string };

const HAS_SCHEME = /^[a-z][a-z\d+.-]*:/i;
// A literal `https://` followed by a host character sends the parser to the
// authority state whatever the base, and nothing after it reads the base again,
// so dot segments resolve against the value's own path. Spellings the parser
// forgives (`https:host`, `https:/host`) parse alone but resolve against the
// page when the page is https too; those, and backslash forms, are refused
// rather than reasoned about one at a time.
const EXPLICIT_AUTHORITY = /^https:\/\/[^/\\?#]/i;

// `url` is what to store: the trimmed input, with `https://` prepended when it
// named no scheme. It is not `URL.href`, which would rewrite an IDN host to
// punycode and show the member something they did not type.
export function checkProfileUrl(raw: string): ProfileUrlCheck {
	const trimmed = raw.trim();
	const url = HAS_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`;
	if (url.length > MAX_PROFILE_URL_LENGTH) {
		return { ok: false, reason: `is longer than ${MAX_PROFILE_URL_LENGTH} characters` };
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { ok: false, reason: 'is not a valid web address' };
	}
	if (parsed.protocol !== 'https:') return { ok: false, reason: 'must start with https://' };
	if (!parsed.hostname) return { ok: false, reason: 'has no host' };
	if (parsed.username || parsed.password) {
		return { ok: false, reason: 'must not carry a username or password' };
	}
	if (!EXPLICIT_AUTHORITY.test(url)) return { ok: false, reason: 'must start with https://' };
	return { ok: true, url };
}

// What a stored value may link to, or null to render it as text. Rows written
// before the check existed, or by the CSV import, never went through it.
export function profileHref(stored: string | null | undefined): string | null {
	if (!stored?.trim()) return null;
	const c = checkProfileUrl(stored);
	return c.ok ? c.url : null;
}

export type BadProfileUrl = { memberId: string; key: string; value: string; reason: string };

// Every stored url-typed value the check refuses, for the read-only report in
// scripts/report-bad-profile-urls.ts.
export function badProfileUrls(
	members: readonly { id: string; values: Record<string, unknown> }[],
	urlKeys: readonly string[]
): BadProfileUrl[] {
	const out: BadProfileUrl[] = [];
	for (const m of members) {
		for (const key of urlKeys) {
			if (!Object.hasOwn(m.values, key)) continue;
			const value = String(m.values[key] ?? '');
			if (!value.trim()) continue;
			const c = checkProfileUrl(value);
			if (!c.ok) out.push({ memberId: m.id, key, value, reason: c.reason });
		}
	}
	return out;
}
