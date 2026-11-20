// The client half of Gravatar: the URL shape and the branded hash type.
//
// Minting a hash needs an address, so it lives server-side in
// $lib/server/gravatar.ts. Splitting the two is what makes "the hash is minted
// where the address lives" a property of the module graph rather than a habit —
// a client component importing this file cannot reach the function that turns an
// address into a hash, because it is not in this file to import.

declare const gravatarHashBrand: unique symbol;

// sha256(trimmed, lowercased address) — the key Gravatar images are addressed
// by. Branded rather than a bare string so a component prop can demand one: the
// only thing stopping a new call site handing an address to <Gravatar> is the
// type refusing it.
export type GravatarHash = string & { readonly [gravatarHashBrand]: true };

export type GravatarOpts = {
	// Rendered pixel size requested from Gravatar (default 80).
	size?: number;
	// Fallback when the address has no Gravatar. '404' returns an HTTP 404 rather
	// than a generated image, which is what lets a caller tell "no photo" from
	// "here is a robot"; other options: 'identicon', 'mp' (silhouette), 'retro'.
	d?: string;
};

export function gravatarUrl(hash: GravatarHash, opts: GravatarOpts = {}): string {
	const size = opts.size ?? 80;
	const d = opts.d ?? 'identicon';
	return `https://gravatar.com/avatar/${hash}?s=${size}&d=${encodeURIComponent(d)}`;
}
