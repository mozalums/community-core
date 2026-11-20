import { getAvatarByPublicId } from '$lib/server/avatars';
import { scheduleRefresh } from '$lib/server/gravatar';
import { clientAddress } from '$lib/server/client-address';
import { log } from '$lib/server/log';
import { rateLimitKey, rateLimited } from '$lib/server/rate-limit';
import type { RequestHandler } from './$types';

// Public avatar image at /avatar/<public id>, where the id is a random uuid per
// stored photo. It is deliberately unauthenticated: the landing showcase serves
// guests, and the sheet's Bio Pic column links here. That is exactly why the id
// cannot be derived from the member's address. While the URL was md5(email),
// anyone could hash a guessed address and read that person's membership off the
// status code, against any candidate list, at whatever speed the box answered.
//
// A hit serves the stored bytes with ETag revalidation, so replacing a photo
// shows immediately without re-downloading unchanged images. Every other
// outcome (malformed id, unknown id) is one identical 404 built in one place,
// so nothing distinguishes "no such photo" from "not an id at all".
//
// Gravatar is consulted from here, server-side, and never by the visitor. A row
// past its TTL is refreshed in the background: this handler serves whatever it
// already holds and returns, so no visitor ever waits on Automattic, and a cold
// row 404s into the initials disc until the fetch lands. Redirecting to Gravatar
// instead would have put the address hash in a Location header and handed back
// the oracle the public id exists to close.
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// A page renders one request per photo, so the ceiling has to clear a full
// directory several times over for every browser behind one address — offices
// and carrier NAT share a key. It bounds bulk download rather than enumeration
// (a guessed id is 122 bits away), so it fails open: a Redis outage must not
// blank every avatar on the site.
const RL_MAX = 1200;
const RL_WINDOW_S = 600;

// One constructor for both refusals. Two hand-rolled 404s drift, and the drift
// is the oracle.
function notFound(): Response {
	return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
}

export const GET: RequestHandler = async (event) => {
	const { params, request } = event;
	const id = params.id.toLowerCase();
	// Before any I/O, so a request for md5(someone@example.com) executes the same
	// instructions whoever that address belongs to — no Redis, no query, no row.
	if (!ID_RE.test(id)) return notFound();

	// Metered after the format check: garbage costs a regex and nothing else, and
	// billing it would let one broken client lock every other caller behind the
	// same NAT out of their avatars.
	const ip = clientAddress(event);
	const over = await rateLimited(rateLimitKey('avatar-rl:ip', ip), RL_MAX, RL_WINDOW_S).catch(
		(e) => {
			log.warn('avatar.ratelimit-unavailable', { ip, error: String(e) });
			return false;
		}
	);
	if (over) {
		// Safe to distinguish, unlike the 404s above: this answers a question about
		// the caller's own request rate, not about any address.
		log.warn('avatar.rate-limited', { ip });
		return new Response('slow down', {
			status: 429,
			headers: { 'cache-control': 'no-store', 'retry-after': String(RL_WINDOW_S) }
		});
	}

	const avatar = await getAvatarByPublicId(id);
	if (!avatar) return notFound();

	// Fire-and-forget, before the early return below, so a `none` row is refreshed
	// too: the member who has just created a Gravatar is precisely the one whose
	// row says there is nothing to fetch.
	scheduleRefresh(avatar);

	// A row with no bytes is the negative cache — Gravatar had nothing, or we have
	// not asked yet. Same 404 as an unknown id, so the response still says nothing
	// about whether the address behind it exists.
	if (!avatar.bytes || !avatar.contentType) return notFound();

	const etag = `"${avatar.updatedAt.getTime()}"`;
	if (request.headers.get('if-none-match') === etag) {
		return new Response(null, { status: 304, headers: { etag, 'cache-control': 'no-cache' } });
	}
	// Copy into a fresh ArrayBuffer-backed view (valid BodyInit; also avoids
	// handing out a slice of Node's shared Buffer pool).
	return new Response(new Uint8Array(avatar.bytes), {
		status: 200,
		headers: {
			'content-type': avatar.contentType,
			'cache-control': 'no-cache',
			etag
		}
	});
};
