// Server-side Gravatar: mint the hash, and fetch an image on the app's own
// behalf instead of sending a visitor's browser to Automattic.
//
// Fetching here rather than in an <img> is the whole point. A hotlinked avatar
// announces one member per image to a third party, from the browser of whoever
// loaded the page, and puts a hash of that member's address in the page source
// where anyone holding a candidate address can confirm membership by hashing it.
// Pulling the bytes once, server-side, and re-serving them from /avatar/<uuid>
// removes both: no hash in any payload, and no visitor request to a party the
// visitor has no relationship with.
//
// Automattic's API Terms of Use permit the cache and attach conditions to it
// (developer.wordpress.com/guidelines): refresh stored content at a reasonable
// interval, tell people the app stores it, and do not place excessive calls.
// TTL_MS and the conditional request below are those conditions in code.

import { createHash } from 'node:crypto';
import type { GravatarHash } from '$lib/gravatar';
import { getAvatarByEmail, recordGravatar, type AvatarRow } from '$lib/server/avatars';
import { log } from '$lib/server/log';

// sha256, not md5. Gravatar's own spec says "Don't use MD5!", and the weaker
// digest is also the one that makes a membership oracle cheap: confirming a
// guessed address against an md5 is orders of magnitude less work than against
// a sha256. The storage key in avatars.ts stays md5 on purpose — that one is
// internal, never leaves the server, and re-keying the table buys nothing.
export function gravatarHash(email: string | null | undefined): GravatarHash {
	return createHash('sha256')
		.update((email ?? '').trim().toLowerCase())
		.digest('hex') as GravatarHash;
}

// How long a cached answer stands before the next request revalidates it. Seven
// days is a deliberate override of Gravatar's own `cache-control: max-age=300`:
// honouring five minutes literally would re-ask for every member roughly 2,000
// times a week, which is the "excessive API calls" their terms prohibit. Their
// header is tuned for a browser holding one avatar, not for a cache holding a
// roster.
export const TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Requested at 2x the largest rendered size (the showcase paints at 72px), so
// one stored copy serves every call site on a retina display.
const REQUEST_SIZE = 144;

// A slow third party must not hold a request open. Past this the caller keeps
// whatever it already had, which for a cold row is the initials disc.
const TIMEOUT_MS = 5000;

const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

export type GravatarFetch =
	| { outcome: 'image'; bytes: Buffer; contentType: string; lastModified: string | null }
	/** Gravatar has nothing for this address. Cache it, or every render re-asks. */
	| { outcome: 'none' }
	/** Unchanged since `lastModified`. No bytes moved; only freshness advances. */
	| { outcome: 'unchanged' }
	/** Network error, timeout, or a 5xx. Keep what we have and try again later. */
	| { outcome: 'error'; reason: string };

/**
 * Ask Gravatar for one avatar, conditionally when we already hold a copy.
 *
 * `d=404` is what separates "no photo" from "a generated robot": without it
 * Gravatar answers 200 with an identicon for every address that has nothing,
 * and the cache fills with pictures no member chose. Passing the stored
 * Last-Modified turns a refresh into a 304 with an empty body, which is the
 * cheapest possible way to honour the refresh-at-reasonable-intervals term.
 * They send no ETag, so If-Modified-Since is the only conditional they answer.
 */
export async function fetchGravatar(
	hash: GravatarHash,
	lastModified?: string | null
): Promise<GravatarFetch> {
	const url = `https://gravatar.com/avatar/${hash}?s=${REQUEST_SIZE}&d=404`;
	const headers: Record<string, string> = {};
	if (lastModified) headers['if-modified-since'] = lastModified;

	let res: Response;
	try {
		res = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(TIMEOUT_MS),
			redirect: 'follow'
		});
	} catch (e) {
		return { outcome: 'error', reason: e instanceof Error ? e.message : String(e) };
	}

	if (res.status === 304) return { outcome: 'unchanged' };
	if (res.status === 404) return { outcome: 'none' };
	if (!res.ok) return { outcome: 'error', reason: `HTTP ${res.status}` };

	// Trust the declared type only from this fixed list. The bytes are re-served
	// from our own origin, so a content-type we pass through unchecked is a
	// content-type we would hand a visitor under our own domain.
	const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (!ALLOWED_TYPES.has(contentType)) {
		return { outcome: 'error', reason: `unexpected content-type ${contentType || '(none)'}` };
	}

	const bytes = Buffer.from(await res.arrayBuffer());
	if (bytes.length === 0) return { outcome: 'error', reason: 'empty body' };

	return {
		outcome: 'image',
		bytes,
		contentType,
		lastModified: res.headers.get('last-modified')
	};
}

// --- Refresh scheduling ----------------------------------------------------
//
// No request ever awaits Gravatar. A cold row 404s and the initials disc shows,
// exactly as it does today; the photo appears on the next load. That is a
// deliberate trade: making the first visitor wait on a third party to paint a
// decorative image is the wrong way round, and <Gravatar> already renders the
// disc first and paints over it, so the degraded state is the designed one.

/** In flight, keyed by address, so one member is never fetched twice at once. */
const inFlight = new Set<string>();

// A cold landing page wants 260 avatars in one render. Firing that at Gravatar
// at once is the "overburden Automattic systems" clause and would also park 260
// sockets in this process. Four at a time drains a full roster in about a minute
// of background work and is invisible to every request.
const MAX_CONCURRENT = 4;
let active = 0;
const waiting: (() => void)[] = [];

async function slot(): Promise<() => void> {
	if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
	active += 1;
	let done = false;
	return () => {
		if (done) return;
		done = true;
		active -= 1;
		waiting.shift()?.();
	};
}

/** True when a row has never been asked about, or was asked longer ago than the TTL. */
export function isStale(row: Pick<AvatarRow, 'source' | 'fetchedAt'>, now = Date.now()): boolean {
	// An upload is the member's own decision and is never revalidated: there is
	// nothing at Gravatar that should be allowed to replace it.
	if (row.source === 'upload') return false;
	if (!row.fetchedAt) return true;
	return now - row.fetchedAt.getTime() >= TTL_MS;
}

/**
 * Bring one row up to date in the background, if it is stale and not already
 * being fetched. Returns immediately; the caller never awaits the network.
 *
 * Errors are swallowed after logging on purpose. This runs detached from any
 * request, so a rejection here would be an unhandled rejection rather than a
 * failed response, and a Gravatar outage must not be able to take the process
 * down over a decorative image.
 */
export function scheduleRefresh(
	row: Pick<AvatarRow, 'source' | 'fetchedAt' | 'email' | 'lastModified'>
): void {
	if (!isStale(row)) return;
	const key = row.email.trim().toLowerCase();
	if (inFlight.has(key)) return;
	inFlight.add(key);

	void (async () => {
		const release = await slot();
		try {
			// The stored Last-Modified goes back out as If-Modified-Since, so an
			// unchanged photo costs a 304 and no bytes. Dropping it here would turn
			// every weekly refresh into a full re-download of the whole roster.
			const res = await fetchGravatar(gravatarHash(row.email), row.lastModified);
			if (res.outcome === 'error') {
				// Left stale rather than recorded, so the next request retries. A
				// timeout is not evidence that a member has no photo, and writing one
				// as 'none' would cache a network blip for a week.
				log.warn('gravatar.refresh-failed', { reason: res.reason });
				return;
			}
			await recordGravatar(key, res);
		} catch (e) {
			log.warn('gravatar.refresh-threw', { error: String(e) });
		} finally {
			release();
			inFlight.delete(key);
		}
	})();
}

/**
 * Refresh one member's own avatar when they sign in.
 *
 * The cleanest reading of Gravatar's "fetch for your active users only": the
 * person authenticating is unambiguously active, and they are also the one most
 * likely to have just changed their picture and be wondering why the site still
 * shows the old one. Waiting out a seven-day TTL is the case this closes.
 *
 * Refreshes an existing row and never creates one. Anyone who completes a magic
 * link gets a session, member or not, and minting a Gravatar lookup for a
 * stranger would be fetching on behalf of somebody this app displays nowhere.
 *
 * Returns void rather than a promise on purpose. Sign-in must not get slower
 * because a third party is slow, so nothing here is on the path to the redirect.
 */
export function refreshOnSignIn(email: string | null | undefined): void {
	const addr = (email ?? '').trim().toLowerCase();
	if (!addr) return;

	void getAvatarByEmail(addr)
		.then((row) => {
			if (row) scheduleRefresh(row);
		})
		.catch((e) => {
			// A failed lookup costs a stale photo for up to a week, never a sign-in.
			log.warn('gravatar.signin-refresh-failed', { error: String(e) });
		});
}
