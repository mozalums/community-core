<script lang="ts">
	import { page } from '$app/stores';
	import Landing from '$lib/components/Landing.svelte';
	import { groupBase } from '$lib/group-nav';
	import type { PageData } from './$types';

	const { data }: { data: PageData } = $props();
	const base = $derived(groupBase($page.url.pathname, data.group.slug));

	// Only signed-in users reach here (guests are redirected to "/"). The CTA sends
	// them onward: members and admins to the directory, others to the request form.
	const inCommunity = $derived(!!data.member || !!data.isGroupAdmin);
	const connectHref = $derived(inCommunity ? `${base}/members` : `${base}/request`);
	const ctaLabel = $derived(inCommunity ? 'Enter the directory' : 'Request membership');
</script>

<Landing
	groupName={data.group.name}
	{connectHref}
	{ctaLabel}
	showRegister={false}
	landingHtml={data.landingHtml}
	heroHtml={data.heroHtml}
	bandHtml={data.bandHtml}
	documents={data.documents}
	teamMembers={data.publicMembers}
	{base}
	profileBase={data.member || data.isGroupAdmin ? base : null}
/>
