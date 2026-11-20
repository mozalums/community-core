// The analytics providers a skin may switch on, and everything each one needs
// from the page and from the Content-Security-Policy. Plain JavaScript because
// svelte.config.js reads it before anything compiles TypeScript.
//
// A skin names a provider and its site id, never a URL: the script origin is
// fixed here, so a skin change cannot widen what the policy lets a page load.

/**
 * @typedef {{ script: string, origin: `https://${string}.${string}`, attributes: (site: string) => Record<string, string> }} AnalyticsProvider
 */

/** @type {{ fathom: AnalyticsProvider }} */
export const ANALYTICS_PROVIDERS = {
	fathom: {
		script: 'https://cdn.usefathom.com/script.js',
		origin: 'https://cdn.usefathom.com',
		// data-spa="auto" counts SvelteKit's client-side navigations as pageviews.
		attributes: (site) => ({ 'data-site': site, 'data-spa': 'auto' })
	}
};

/**
 * The origins the policy must allow for a skin's `analytics` block, or none
 * when the skin has no block or names a provider this core does not know.
 * @param {unknown} analytics
 * @returns {`https://${string}.${string}`[]}
 */
export function analyticsOrigins(analytics) {
	const provider =
		analytics && typeof analytics === 'object' && 'provider' in analytics
			? analytics.provider
			: undefined;
	/** @type {Record<string, AnalyticsProvider>} */
	const known = ANALYTICS_PROVIDERS;
	return typeof provider === 'string' && Object.hasOwn(known, provider)
		? [known[provider].origin]
		: [];
}
