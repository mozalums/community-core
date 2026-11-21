<script lang="ts">
	import { page } from '$app/stores';
	import { groupBase, groupHome, signInHref, GROUP_GATED_ROUTE } from '$lib/group-nav';
	import TopNav from '$lib/components/TopNav.svelte';
	import Sidebar from '$lib/components/Sidebar.svelte';
	import ThemeToggle from '$lib/components/ThemeToggle.svelte';
	import { brand, site } from '$skin/skin.yaml';
	import { fly, fade } from 'svelte/transition';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	const { data, children }: { data: LayoutData; children: Snippet } = $props();

	// Links follow the URL the visitor is actually on: clean ('') for the
	// default group's root URLs, '/group/<slug>' otherwise.
	const base = $derived(groupBase($page.url.pathname, data.group.slug));
	const home = $derived(groupHome($page.url.pathname, data.group.slug));

	// The signed-in member's own profile link (only synced members have a page;
	// dash-access non-members don't, so no Profile item shows for them).
	const profileHref = $derived(data.member ? `${base}/members/${data.member.ref}` : undefined);

	const isLanding = $derived($page.route.id === '/group/[slug]');
	// The anon home splash, but at /home so signed-in users can view it (guests are
	// redirected to / by its loader). Rendered full-bleed, with no top nav.
	const isHome = $derived($page.route.id === '/group/[slug]/home');
	const isAdmin = $derived($page.route.id?.startsWith('/group/[slug]/admin') ?? false);
	// The membership-request page is a self-contained card with its own header —
	// no top nav (it has a "sign out" link inline instead).
	const isRequest = $derived($page.route.id === '/group/[slug]/request');
	const signedInMember = $derived(!!data.member || !!data.isGroupAdmin);

	// The signed-in member shell (sidebar) covers all in-community pages —
	// directory, profile, admin, etc. The landing + guest/non-member pages keep
	// the top-nav shell.
	const useSidebar = $derived(signedInMember && !isLanding);
	const settingsHref = $derived(data.member ? `${base}/members/${data.member.ref}/edit` : undefined);

	let drawerOpen = $state(false);

	// `no-store` does NOT keep the gated pages out of the back/forward cache:
	// Safari has always bfcache-restored no-store pages, and Chrome can since
	// 117. A restore resurrects the DOM snapshot with no network request, so
	// hooks and load functions never rerun and member data (or a logged-out
	// user's old session view) comes back stale. Force a real load instead —
	// only for gated routes, so public pages keep the bfcache win. A normal
	// load fires pageshow with persisted=false, so this can't loop.
	function onPageshow(e: PageTransitionEvent) {
		if (e.persisted && GROUP_GATED_ROUTE.test($page.route.id ?? '')) location.reload();
	}
</script>

<svelte:window onpageshow={onPageshow} />

<svelte:head>
	<title>{data.group.name}</title>
</svelte:head>

{#if useSidebar}
	<div
		class="flex min-h-screen bg-gradient-to-br from-gray-100 to-gray-50 text-black dark:from-neutral-950 dark:to-neutral-900 dark:text-neutral-100"
	>
		<!-- Desktop sidebar -->
		<div class="sticky top-0 hidden h-screen shrink-0 md:block">
			<Sidebar
				home={`${base}/members`}
				{base}
				groupName={data.group.name}
				memberCount={data.memberCount}
				userEmail={data.user?.email ?? ''}
				userAvatarId={data.userAvatarId}
				buildSha={data.buildSha}
				coreTag={data.coreTag}
				blurbHtml={data.sidebarHtml}
				documents={data.documents}
				{settingsHref}
				isAdmin={!!data.isGroupAdmin}
			/>
		</div>

		<!-- Mobile drawer -->
		{#if drawerOpen}
			<button
				class="fixed inset-0 z-40 bg-black/40 md:hidden"
				aria-label="Close menu"
				onclick={() => (drawerOpen = false)}
				transition:fade={{ duration: 150 }}
			></button>
			<div
				class="fixed inset-y-0 left-0 z-50 md:hidden"
				transition:fly={{ x: -300, duration: 220 }}
			>
				<Sidebar
					home={`${base}/members`}
					{base}
					groupName={data.group.name}
					memberCount={data.memberCount}
					userEmail={data.user?.email ?? ''}
					userAvatarId={data.userAvatarId}
					buildSha={data.buildSha}
					coreTag={data.coreTag}
					blurbHtml={data.sidebarHtml}
					documents={data.documents}
					{settingsHref}
					isAdmin={!!data.isGroupAdmin}
					mobile
					onNavigate={() => (drawerOpen = false)}
				/>
			</div>
			<!-- Theme control: same floating spot as desktop, but only while the
			     drawer is open on mobile (desktop uses the root-layout instance). -->
			<ThemeToggle extraClass="md:hidden" />
		{/if}

		<div class="flex min-w-0 flex-1 flex-col">
			<!-- Mobile top bar -->
			<div
				class="flex items-center gap-3 border-b border-black/10 bg-white/90 px-4 py-3 backdrop-blur dark:border-white/10 dark:bg-neutral-900/90 md:hidden"
			>
				<button
					aria-label="Open menu"
					onclick={() => (drawerOpen = true)}
					class="rounded-md p-1.5 text-gray-600 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
				>
					<svg viewBox="0 0 20 20" fill="currentColor" class="size-6" aria-hidden="true">
						<path
							fill-rule="evenodd"
							d="M2 4.75A.75.75 0 0 1 2.75 4h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75Zm0 5A.75.75 0 0 1 2.75 9h14.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 9.75Zm0 5a.75.75 0 0 1 .75-.75h14.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z"
							clip-rule="evenodd"
						/>
					</svg>
				</button>
				<a href={`${base}/members`}>
					<img src="/{brand.wordmark}" alt={site.name} class="h-7 w-auto dark:invert" />
				</a>
			</div>

			{#if isHome}
				<!-- Home renders the full-bleed Landing splash inside the member shell. -->
				{@render children()}
			{:else}
				<main class="mx-auto w-full px-4 py-8 {isAdmin ? 'max-w-5xl' : 'max-w-3xl'}">
					{@render children()}
				</main>
			{/if}
		</div>
	</div>
{:else}
	<div
		class="min-h-screen bg-gradient-to-br from-gray-100 to-gray-50 text-black dark:from-neutral-950 dark:to-neutral-900 dark:text-neutral-100"
	>
		{#if isLanding || isHome}
			<!-- Marketing / home splash: full-bleed, no top nav. -->
			{@render children()}
		{:else}
			{#if !isRequest}
				<TopNav
					{home}
					{base}
					groupName={data.group.name}
					member={signedInMember}
					isGroupAdmin={!!data.isGroupAdmin}
					signedIn={!!data.user}
					signInHref={signInHref($page.url.pathname, data.group.slug)}
					{profileHref}
				/>
			{/if}
			<main class="mx-auto px-4 py-8 {isAdmin ? 'max-w-5xl' : 'max-w-3xl'}">
				{@render children()}
			</main>
		{/if}
	</div>
{/if}
