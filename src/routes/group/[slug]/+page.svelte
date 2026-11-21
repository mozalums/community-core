<script lang="ts">
	import { page } from '$app/stores';
	import { safeLocalPath } from '$lib/callback-path';
	import Landing from '$lib/components/Landing.svelte';
	import LoginModal from '$lib/components/LoginModal.svelte';
	import { groupBase, signInHref } from '$lib/group-nav';
	import type { PageData } from './$types';

	const { data }: { data: PageData } = $props();
	const base = $derived(groupBase($page.url.pathname, data.group.slug));

	// "Connect" takes the visitor to the next step for their state: members go to
	// the directory, signed-in non-members to the request form, and guests into
	// the sign-in flow (modal when JS is on, /login otherwise).
	const connectHref = $derived(
		data.member || data.isGroupAdmin
			? `${base}/members`
			: data.user
				? `${base}/request`
				: signInHref($page.url.pathname, data.group.slug)
	);

	// A signed-in non-member is already past step one of joining.
	const registerHref = $derived(data.user ? `${base}/request` : `${base}/join`);

	const isGuest = $derived(!data.user);
	let loginOpen = $state(false);

	// Arriving with ?login=1 (e.g. bounced from an admin page) auto-opens the
	// login modal; ?next= carries the intended post-login destination.
	const nextParam = $derived($page.url.searchParams.get('next'));
	const loginCallback = $derived(safeLocalPath(nextParam, `${base}/members`));
	let autoOpened = false;
	$effect(() => {
		if (!autoOpened && isGuest && $page.url.searchParams.get('login') === '1') {
			autoOpened = true;
			loginOpen = true;
		}
	});
</script>

<Landing
	groupName={data.group.name}
	{connectHref}
	{registerHref}
	landingHtml={data.landingHtml}
	heroHtml={data.heroHtml}
	bandHtml={data.bandHtml}
	documents={data.documents}
	onLogin={isGuest ? () => (loginOpen = true) : undefined}
	teamMembers={data.publicMembers}
	{base}
	profileBase={data.member || data.isGroupAdmin ? base : null}
	buildSha={data.buildSha}
	coreTag={data.coreTag}
/>

{#if isGuest}
	<LoginModal bind:open={loginOpen} callbackUrl={loginCallback} />
{/if}
