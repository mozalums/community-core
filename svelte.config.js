import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import adapterNode from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { mdsvex } from 'mdsvex';
import { parse } from 'yaml';
import { analyticsOrigins } from './src/lib/skin/analytics.js';
import { stageSkinAssets } from './src/lib/skin/assets.js';

// The default must match DEFAULT_SKIN_DIR in src/lib/skin/load.ts, which reads
// the same variable for the server.
const skinDir = process.env.SKIN_DIR || 'skin/default';

// Read before the skin plugin validates the file, so only a key a valid skin
// can carry is consulted: an unknown provider adds nothing, and the build then
// fails on it by name.
const analytics = analyticsOrigins(
	parse(readFileSync(fileURLToPath(new URL(`${skinDir}/skin.yaml`, import.meta.url)), 'utf8'))
		?.analytics
);

/** @type {import('@sveltejs/kit').Config} */
const config = {
	extensions: ['.svelte', '.md'],
	kit: {
		adapter: adapterNode(),
		// Core's static files plus the skin's, staged afresh each time this
		// config loads (src/lib/skin/assets.js). A skin file edited under
		// `vite dev` shows after a restart.
		files: { assets: stageSkinAssets(skinDir) },
		alias: {
			$lib: './src/lib',
			// The one switch that selects a skin.
			$skin: skinDir
		},
		// Content-Security-Policy for rendered pages. SvelteKit owns it because it
		// is the only party that knows which inline scripts it emitted: `mode:
		// 'nonce'` stamps its hydration bootstrap and app.html's pre-paint theme
		// script (via %sveltekit.nonce%) with a per-response nonce that a
		// hand-written header could never name. Every other security header is set
		// in src/hooks.server.ts, and nginx carries only HSTS — no header is
		// emitted from two places.
		//
		// What the policy has to allow, and why:
		//   script-src   the analytics origin, only when the skin sets an
		//                `analytics` block (src/lib/skin/analytics.js); the tag
		//                is in +layout.svelte on the same condition.
		//                'unsafe-hashes' plus one sha256 — Svelte's SSR output
		//                stamps `onerror="this.__e=event"` on any <img> with an
		//                error handler, to replay events that fire before
		//                hydration, and an inline handler *attribute* takes
		//                neither a nonce nor a plain hash. That is Gravatar.svelte
		//                in the members directory: block it and an avatar that
		//                404s before hydration never advances to the Gravatar or
		//                the initials, so the broken-image glyph is what the
		//                visitor keeps. The hash covers that exact body and
		//                nothing else — an injected `onerror="alert(1)"` still
		//                fails. Svelte writes the literal in
		//                compiler/phases/3-transform/server/visitors/shared/element.js;
		//                if a Svelte upgrade changes it, the avatar fallback is
		//                where it shows up first.
		//   connect-src  the analytics origin, where that tag sends its pageviews.
		//   img-src      www.gravatar.com — /avatar/<hash> 302s there on a miss,
		//                and CSP re-checks the redirect target, so the <img> that
		//                pointed at our own origin still needs Gravatar allowed;
		//                data: for the SVG control glyphs @tailwindcss/forms
		//                embeds in CSS; blob: for the local preview the avatar
		//                upload builds with URL.createObjectURL; the analytics
		//                origin because that tag's beacon transport is its own
		//                business and a blocked one fails silently.
		//   font-src     'self' alone — a skin that ships a face self-hosts it
		//                in its static/ (the Google Fonts links live in the *email*
		//                template, which no browser policy of ours governs).
		//   style-src    'unsafe-inline', the one concession: Avatar.svelte and
		//                Gravatar.svelte size and colour each element through a
		//                computed `style` attribute, and a style *attribute*
		//                cannot carry a nonce. Dropping it would need
		//                style-src-attr, which fails closed on browsers that
		//                don't know the directive. The XSS value is in script-src,
		//                which keeps no 'unsafe-inline'.
		csp: {
			mode: 'nonce',
			directives: {
				'default-src': ['self'],
				'script-src': [
					'self',
					...analytics,
					'unsafe-hashes',
					'sha256-7dQwUgLau1NFCCGjfn9FsYptB6ZtWxJin6VohGIu20I=' // "this.__e=event"
				],
				'style-src': ['self', 'unsafe-inline'],
				'img-src': ['self', 'data:', 'blob:', 'https://www.gravatar.com', ...analytics],
				'font-src': ['self'],
				'connect-src': ['self', ...analytics],
				'form-action': ['self'],
				'frame-ancestors': ['none'],
				'base-uri': ['self'],
				'object-src': ['none']
			}
		},
		// Deploys never reach already-open tabs: an SPA tab keeps client-side
		// routing on its old bundles (and old fixes) indefinitely. Poll
		// /_app/version.json every 90 seconds so a stale tab notices the new
		// deployment and turns its next navigation into a full-page load.
		version: {
			pollInterval: 90_000
		}
	},
	preprocess: [mdsvex({ extensions: ['.md'] }), vitePreprocess()]
};

export default config;
