// Client-address resolution for rate-limit keys and abuse logging.
//
// adapter-node returns the TCP peer unless ADDRESS_HEADER is set, and behind a
// reverse proxy that peer is the proxy's loopback address — every visitor shares
// one rate-limit bucket. ADDRESS_HEADER on its own is worse rather than better:
// the client picks the key unless the trusted hop count is pinned, so this
// module refuses to read X-Forwarded-For until XFF_DEPTH names how many proxies
// wrote it.
//
// Resolution lives here instead of delegating to adapter-node's own
// getClientAddress() because that throws when the header is absent or the chain
// is shorter than XFF_DEPTH, turning a proxy misconfiguration into a 500 on
// every request. The posture here is loud but alive: warn, then key on the peer.

import type { RequestEvent } from '@sveltejs/kit';
import { log } from './log';

// Last-resort key, and never the empty string: an empty or undefined
// rate-limit key merges every caller into one bucket, which is the exact
// collapse this module exists to prevent.
export const UNKNOWN_ADDRESS = 'unknown';

export type ProxyEnv = {
	/** Header the trusted proxy writes the client address into. */
	addressHeader: string | undefined;
	/** Count of trusted proxies, read right-to-left from the app. */
	xffDepth: string | undefined;
};

/**
 * Resolve the address to key rate limits on, given the request headers and the
 * TCP peer. Every disagreement between the proxy and the configuration falls
 * back to `peer` — wrong-but-bounded beats attacker-authored.
 */
export function resolveClientAddress(args: {
	headers: Headers;
	peer: string | null;
	path?: string;
	env: ProxyEnv;
}): string {
	const { headers, path, env } = args;
	const peer = args.peer || UNKNOWN_ADDRESS;

	const header = (env.addressHeader ?? '').trim().toLowerCase();
	if (!header) return peer;

	const value = headers.get(header);
	if (value === null) {
		log.warn('proxy.address-header-missing', {
			header,
			path,
			peer,
			hint: 'ADDRESS_HEADER is set but the proxy did not send it — see docs/operations.md, Reverse proxy'
		});
		return peer;
	}

	if (header !== 'x-forwarded-for') return value.trim() || peer;

	const depth = Number(env.xffDepth);
	if (!Number.isInteger(depth) || depth < 1) {
		log.error('proxy.xff-depth-invalid', {
			path,
			xffDepth: env.xffDepth ?? null,
			hint: 'XFF_DEPTH must be a positive integer naming the trusted hop count; X-Forwarded-For is client-writable without it'
		});
		return peer;
	}

	const hops = value
		.split(',')
		.map((hop) => hop.trim())
		.filter(Boolean);
	if (hops.length < depth) {
		log.warn('proxy.xff-depth-mismatch', {
			path,
			xffDepth: depth,
			hops: hops.length,
			hint: 'fewer hops than XFF_DEPTH claims — a trusted proxy did not append its peer'
		});
		return peer;
	}

	return hops[hops.length - depth];
}

// adapter-node hands the raw Node request through `platform`, and its socket is
// the only peer left once ADDRESS_HEADER makes getClientAddress() throw. Vite's
// dev server has no platform and no ADDRESS_HEADER, so getClientAddress() is
// already the peer there.
function peerAddress(event: RequestEvent): string | null {
	const socket = event.platform?.req?.socket?.remoteAddress;
	if (socket) return socket;
	try {
		return event.getClientAddress() || null;
	} catch {
		return null;
	}
}

export function clientAddress(event: RequestEvent): string {
	return resolveClientAddress({
		headers: event.request.headers,
		peer: peerAddress(event),
		path: event.url.pathname,
		env: { addressHeader: process.env.ADDRESS_HEADER, xffDepth: process.env.XFF_DEPTH }
	});
}
