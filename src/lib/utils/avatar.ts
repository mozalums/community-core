// Subject-based avatar — maps an OIDC subject (e.g. `github:mankins`,
// `email:matt@example.com`) into a deterministic gradient + initials. We
// don't try to fetch a real avatar (gravatar etc.) because cyan's auth
// often gives synthetic emails; the gradient identity is more reliable.

import { colorizer } from './colorizer';

/** Best-guess "name" half of an OIDC subject (`github:mankins` → `mankins`). */
export function nameFromSubject(subject: string | null | undefined): string {
	if (!subject) return '??';
	const idx = subject.indexOf(':');
	if (idx < 0) return subject;
	const tail = subject.slice(idx + 1).trim();
	return tail || subject;
}

// A bracketed or quoted token is a nickname the sheet carries inside the
// first-name cell (`Margaret (Maggie) Schroeder`), not a name to initial.
// Tested before the token is cleaned: cleaning `(Maggie)` leaves `Maggie`,
// which is indistinguishable from a real name part.
const NICKNAME = /^[([{"'“‘]/;
// Letters and numbers in any script — an ASCII class would read `Élodie` as
// `lodie` and `山田` as nothing at all.
const NOT_ALNUM = /[^\p{L}\p{N}]/gu;

/** 1–2 character initials from the subject's name half. */
export function initialsFromSubject(subject: string | null | undefined): string {
	const name = nameFromSubject(subject);
	const parts = name
		.split(/\s+/)
		.filter((p) => !NICKNAME.test(p))
		.map((p) => p.replace(NOT_ALNUM, ''))
		.filter(Boolean);
	// First and last, not first and second: the family name is the identifying
	// half. `matt mankins` → `MM`, `Margaret (Maggie) Schroeder` → `MS`,
	// `J. R. R. Tolkien` → `JT`.
	if (parts.length > 1) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
	// `mankins` → `MA`, `m@example.com` → `ME`.
	if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
	// Every token was dropped as a nickname (`(Maggie)`) — two letters from it
	// beats `??`.
	const cleaned = name.replace(NOT_ALNUM, '');
	return cleaned ? cleaned.slice(0, 2).toUpperCase() : '??';
}

/**
 * CSS `background:` value — radial gradient between two palette colors
 * derived from the subject.
 */
export function avatarGradient(subject: string | null | undefined): string {
	const a = colorizer(subject || '??');
	const b = colorizer('1' + (subject || '??'));
	return `radial-gradient(${a}, ${b})`;
}
