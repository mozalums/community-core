import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Thin group-scoped entry into the magic-link sign-in. Redirects to the shared
// /login page, carrying the group's directory as the post-login destination.
// After sign-in the membership gate decides member → directory vs non-member →
// request.
export const load: PageServerLoad = async ({ params, locals }) => {
	const dest = `/group/${params.slug}/members`;
	if (locals.user) throw redirect(303, dest);
	throw redirect(303, `/login?callbackUrl=${encodeURIComponent(dest)}`);
};
