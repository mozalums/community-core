import { json } from '@sveltejs/kit';
import { clientAddress } from '$lib/server/client-address';
import { sendMagicLink } from '$lib/server/magic-link';
import type { RequestHandler } from './$types';

// Modal + no-JS form both POST here. Response is intentionally generic so the
// endpoint leaks nothing about whether an address exists or was rate-limited.
export const POST: RequestHandler = async (event) => {
	const { request, url } = event;
	let body: { email?: string; callbackUrl?: string } = {};
	try {
		body = await request.json();
	} catch {
		body = {};
	}

	await sendMagicLink({
		email: body.email ?? '',
		callbackUrl: body.callbackUrl ?? null,
		origin: url.origin,
		ip: clientAddress(event)
	});

	return json({ ok: true });
};
