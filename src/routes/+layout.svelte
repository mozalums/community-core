<script lang="ts">
	import '$lib/styles/app.css';
	// After app.css, so the skin's properties and faces are declared once the
	// base layer that reads them is.
	import '$skin/theme.css';
	import Toasts from '$lib/components/Toasts.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { ANALYTICS_PROVIDERS } from '$lib/skin/analytics.js';
	import { analytics, brand, site, theme } from '$skin/skin.yaml';
	import type { Snippet } from 'svelte';

	const { children }: { children: Snippet } = $props();

	const tracker = analytics && {
		src: ANALYTICS_PROVIDERS[analytics.provider].script,
		...ANALYTICS_PROVIDERS[analytics.provider].attributes(analytics.site)
	};
</script>

<!-- Every page sets its own title; this one stands where a page does not. The
     browser's theme color is the skin's light accent, the one its pages and mail
     use; app.html and ThemeToggle repaint it with the dark one in dark mode.
     The analytics tag is emitted only for a skin with an `analytics` block, and
     svelte.config.js allows its origin on the same condition. -->
<svelte:head>
	<title>{site.name}</title>
	<meta name="theme-color" content={theme.light.accent} />
	<link
		rel="icon"
		href="/{brand.mark}"
		type={brand.mark.endsWith('.svg') ? 'image/svg+xml' : 'image/png'}
	/>
	{#if tracker}
		<script {...tracker} defer></script>
	{/if}
</svelte:head>

<Toasts />
{@render children()}
<ThemeToggle />
