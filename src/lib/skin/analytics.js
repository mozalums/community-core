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
		// data-spa="auto" counts SvelteKit's client-side navigations as pageviews;
		// data-honor-dnt has the script count nothing for a browser sending DNT.
		attributes: (site) => ({ 'data-site': site, 'data-spa': 'auto', 'data-honor-dnt': 'true' })
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

/**
 * The analytics tag's attributes for a skin's `analytics` block, or null when
 * the skin has none or the browser sends Global Privacy Control. Fathom honors
 * DNT itself but not GPC, so GPC is decided here, before the script loads.
 * @param {{ provider: keyof typeof ANALYTICS_PROVIDERS, site: string } | undefined} analytics
 * @param {object} nav `navigator`, whose DOM type does not declare `globalPrivacyControl`
 * @returns {Record<string, string> | null}
 */
export function analyticsTag(analytics, nav) {
	if (!analytics) return null;
	if ('globalPrivacyControl' in nav && nav.globalPrivacyControl === true) return null;
	const provider = ANALYTICS_PROVIDERS[analytics.provider];
	return { src: provider.script, ...provider.attributes(analytics.site) };
}
