// Admin gate. The set of admin OIDC subjects lives in env (ADMIN_SUBJECTS,
// comma-separated). Empty = no admins, which is the safe default.
//
// We keep this as an env var rather than a DB table while the admin set
// is small (1–2 people). Promote to a `cyan_admins` table when membership
// becomes more dynamic — the public API (`isAdmin`, `requireAdmin`) stays
// the same.

import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

function adminList(): string[] {
	return (env.ADMIN_SUBJECTS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

export function isAdmin(subject: string | null | undefined): boolean {
	if (!subject) return false;
	return adminList().includes(subject);
}

/**
 * Throws a 403 if the subject isn't an admin. Use at the top of any
 * /api/admin/* handler as a defense-in-depth check on top of the
 * `(app)/admin/+layout.server.ts` page guard.
 */
export function requireAdmin(subject: string | null | undefined): asserts subject is string {
	if (!isAdmin(subject)) throw error(403, 'forbidden');
}
