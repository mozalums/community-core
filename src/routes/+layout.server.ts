import type { LayoutServerLoad } from './$types';

// Expose the signed-in identity (if any) to every page. Membership and
// group-admin resolution happen per-group in `group/[slug]/+layout.server.ts`,
// not here — the root layout stays tenant-agnostic.
export const load: LayoutServerLoad = async ({ locals }) => {
	return { user: locals.user ?? null };
};
