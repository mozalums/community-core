<script lang="ts">
	// Signed-in member shell nav. Replaces the top nav on the directory-family
	// pages: brand + manifesto blurb, directory search, nav links, and a bottom
	// user area (Your Profile on its own row, sign-out as an icon).
	//
	// Two orderings share one set of sections (rendered via snippets):
	//  - desktop (default): brand → blurb → spacer → search → nav → user
	//  - mobile (drawer):   brand → search → nav → user → rule → blurb
	import { page } from '$app/stores';
	import NavSearch from '$lib/components/NavSearch.svelte';
	import Gravatar from '$lib/components/Gravatar.svelte';
	import SignOut from '$lib/components/SignOut.svelte';
	import { id as skinId } from '$skin/skin.yaml';
	import { brand as skinBrand, site } from '$skin/skin.yaml';

	type Props = {
		home: string;
		base: string;
		groupName: string;
		memberCount: number;
		userEmail: string;
		/** The signed-in user's uploaded photo, null when they have none. */
		userAvatarId: string | null;
		/** Short commit the running image was built from, '' when a build gave none. */
		buildSha?: string;
		/** The core release tag the image was built from, '' when it has none. */
		coreTag?: string;
		/** The skin's copy/sidebar.md, rendered; '' leaves the text out. */
		blurbHtml?: string;
		/** Which of the skin's documents exist, so only those are linked. */
		documents?: { manifesto: boolean; codeOfConduct: boolean; privacy: boolean };
		settingsHref?: string;
		isAdmin?: boolean;
		mobile?: boolean;
		onNavigate?: () => void;
	};
	const {
		home,
		base,
		groupName,
		memberCount,
		userEmail,
		userAvatarId,
		buildSha = '',
		coreTag = '',
		blurbHtml = '',
		documents = { manifesto: false, codeOfConduct: false, privacy: false },
		settingsHref,
		isAdmin = false,
		mobile = false,
		onNavigate
	}: Props = $props();

	const directoryHref = $derived(`${base}/members`);
	const isMembersRoute = $derived($page.route.id === '/group/[slug]/members');
	const onStarred = $derived(isMembersRoute && $page.url.searchParams.get('starred') === '1');
	const onDirectory = $derived(isMembersRoute && !onStarred);
	const onAdmin = $derived($page.route.id?.startsWith('/group/[slug]/admin') ?? false);
	const onHome = $derived($page.route.id === '/group/[slug]/home');
	const onManifesto = $derived($page.route.id === '/group/[slug]/manifesto');
	const onCodeOfConduct = $derived($page.route.id === '/group/[slug]/code-of-conduct');
	const onPrivacy = $derived($page.route.id === '/group/[slug]/privacy');
</script>

{#snippet brand()}
	<!-- The running commit hangs off the logo's tooltip rather than printing in
	     the footer: a signed-in visitor is redirected past the landing page that
	     carries the same value, so this stays their only way to read which build
	     is serving them — just not one that takes up room on every page. -->
	<a href={home} onclick={onNavigate} class="inline-block" aria-label="{groupName} — directory">
		<img
			src="/{skinBrand.wordmark}"
			alt={site.name}
			title={buildSha
				? `build ${buildSha}${coreTag ? ` · core ${coreTag}` : ''} · skin ${skinId}`
				: undefined}
			class="h-10 w-auto dark:invert"
		/>
	</a>
{/snippet}

{#snippet blurb()}
	<div
		class="space-y-3 text-sm leading-relaxed text-gray-600 dark:text-neutral-400 [&_a]:underline"
	>
		{@html blurbHtml}
		{#if documents.manifesto || documents.codeOfConduct || documents.privacy}
			<div class="flex flex-col gap-1">
				{#if documents.manifesto}
					<a
						href={`${base}/manifesto`}
						onclick={onNavigate}
						class="text-black underline underline-offset-2 hover:text-gray-600 dark:text-neutral-100 dark:hover:text-neutral-400 {onManifesto
							? 'font-bold'
							: ''}"
					>
						Manifesto
					</a>
				{/if}
				{#if documents.codeOfConduct}
					<a
						href={`${base}/code-of-conduct`}
						onclick={onNavigate}
						class="text-black underline underline-offset-2 hover:text-gray-600 dark:text-neutral-100 dark:hover:text-neutral-400 {onCodeOfConduct
							? 'font-bold'
							: ''}"
					>
						Code of Conduct
					</a>
				{/if}
				{#if documents.privacy}
					<a
						href={`${base}/privacy`}
						onclick={onNavigate}
						class="text-black underline underline-offset-2 hover:text-gray-600 dark:text-neutral-100 dark:hover:text-neutral-400 {onPrivacy
							? 'font-bold'
							: ''}"
					>
						Privacy
					</a>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet search()}
	<p class="text-sm font-bold text-gray-900 dark:text-neutral-100">Search</p>
	<p class="mb-2 text-xs text-gray-400 dark:text-neutral-500">
		{memberCount}
		{memberCount === 1 ? 'member' : 'members'}
	</p>
	<NavSearch {base} {onNavigate} />
{/snippet}

{#snippet navLinks()}
	<nav class="space-y-1 text-sm">
		<a
			href={`${base}/home`}
			onclick={onNavigate}
			class="flex items-center gap-2 rounded-md px-2 py-1.5 {onHome
				? 'font-semibold text-gray-900 dark:text-neutral-100'
				: 'text-gray-600 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5'}"
		>
			<svg
				viewBox="0 0 20 20"
				fill="currentColor"
				class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
				aria-hidden="true"
			>
				<path
					fill-rule="evenodd"
					d="M9.293 2.293a1 1 0 0 1 1.414 0l7 7A1 1 0 0 1 17 11h-1v6a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-3a1 1 0 0 0-1-1H9a1 1 0 0 0-1 1v3a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-6H3a1 1 0 0 1-.707-1.707l7-7Z"
					clip-rule="evenodd"
				/>
			</svg>
			Home
		</a>

		<a
			href={directoryHref}
			onclick={onNavigate}
			class="flex items-center gap-2 rounded-md px-2 py-1.5 {onDirectory
				? 'font-semibold text-gray-900 dark:text-neutral-100'
				: 'text-gray-600 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5'}"
		>
			<svg
				viewBox="0 0 20 20"
				fill="currentColor"
				class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
				aria-hidden="true"
			>
				<path
					d="M10 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM1.49 15.326a.78.78 0 0 1-.358-.442 3 3 0 0 1 4.308-3.516 6.484 6.484 0 0 0-1.905 3.959c-.023.222-.014.442.025.654a4.97 4.97 0 0 1-2.07-.655ZM16.44 15.98a4.97 4.97 0 0 0 2.07-.654.78.78 0 0 0 .357-.442 3 3 0 0 0-4.308-3.517 6.484 6.484 0 0 1 1.907 3.96 2.32 2.32 0 0 1-.026.654ZM18 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0ZM5.304 16.19a.844.844 0 0 1-.277-.71 5 5 0 0 1 9.947 0 .843.843 0 0 1-.277.71A6.975 6.975 0 0 1 10 18a6.974 6.974 0 0 1-4.696-1.81Z"
				/>
			</svg>
			Directory
		</a>

		<a
			href={`${base}/members?starred=1`}
			onclick={onNavigate}
			class="flex items-center gap-2 rounded-md px-2 py-1.5 {onStarred
				? 'font-semibold text-gray-900 dark:text-neutral-100'
				: 'text-gray-600 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5'}"
		>
			<svg
				viewBox="0 0 20 20"
				fill="currentColor"
				class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
				aria-hidden="true"
			>
				<path
					fill-rule="evenodd"
					d="M10.868 2.884c-.321-.772-1.415-.772-1.736 0l-1.83 4.401-4.753.381c-.833.067-1.171 1.107-.536 1.651l3.62 3.102-1.106 4.637c-.194.813.691 1.456 1.405 1.02L10 15.591l4.069 2.485c.713.436 1.598-.207 1.404-1.02l-1.106-4.637 3.62-3.102c.635-.544.297-1.584-.536-1.65l-4.752-.382-1.831-4.401Z"
					clip-rule="evenodd"
				/>
			</svg>
			Starred People
		</a>

		{#if isAdmin}
			<a
				href={`${base}/admin`}
				onclick={onNavigate}
				class="flex items-center gap-2 rounded-md px-2 py-1.5 {onAdmin
					? 'font-semibold text-gray-900 dark:text-neutral-100'
					: 'text-gray-600 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5'}"
			>
				<svg
					viewBox="0 0 20 20"
					fill="currentColor"
					class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
					aria-hidden="true"
				>
					<path
						fill-rule="evenodd"
						d="M8.34 1.804A1 1 0 0 1 9.32 1h1.36a1 1 0 0 1 .98.804l.295 1.473c.497.144.971.342 1.416.587l1.25-.834a1 1 0 0 1 1.262.125l.962.962a1 1 0 0 1 .125 1.262l-.834 1.25c.245.445.443.919.587 1.416l1.473.294a1 1 0 0 1 .804.98v1.361a1 1 0 0 1-.804.98l-1.473.295a6.95 6.95 0 0 1-.587 1.416l.834 1.25a1 1 0 0 1-.125 1.262l-.962.962a1 1 0 0 1-1.262.125l-1.25-.834a6.953 6.953 0 0 1-1.416.587l-.294 1.473a1 1 0 0 1-.98.804H9.32a1 1 0 0 1-.98-.804l-.295-1.473a6.957 6.957 0 0 1-1.416-.587l-1.25.834a1 1 0 0 1-1.262-.125l-.962-.962a1 1 0 0 1-.125-1.262l.834-1.25a6.957 6.957 0 0 1-.587-1.416l-1.473-.294A1 1 0 0 1 1 10.68V9.32a1 1 0 0 1 .804-.98l1.473-.295c.144-.497.342-.971.587-1.416l-.834-1.25a1 1 0 0 1 .125-1.262l.962-.962A1 1 0 0 1 5.38 3.03l1.25.834a6.957 6.957 0 0 1 1.416-.587l.294-1.473ZM13 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"
						clip-rule="evenodd"
					/>
				</svg>
				Admin
			</a>
		{/if}
	</nav>
{/snippet}

{#snippet userArea()}
	<div class="space-y-2 text-sm">
		{#if settingsHref}
			<a
				href={settingsHref}
				onclick={onNavigate}
				class="flex items-center gap-2 rounded-md px-2 py-1.5 text-gray-600 hover:bg-black/5 dark:text-neutral-400 dark:hover:bg-white/5"
			>
				<svg
					viewBox="0 0 20 20"
					fill="currentColor"
					class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
					aria-hidden="true"
				>
					<path
						fill-rule="evenodd"
						d="M10 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3.465 14.493a1.23 1.23 0 0 0 .41 1.412A9.957 9.957 0 0 0 10 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 0 0-13.074.003Z"
						clip-rule="evenodd"
					/>
				</svg>
				Your Profile
			</a>
		{/if}

		<div class="flex items-center gap-2 px-2 py-1.5">
			<Gravatar name={userEmail} size={32} avatarId={userAvatarId} />
			<span class="min-w-0 flex-1 truncate text-gray-600 dark:text-neutral-400">{userEmail}</span>
			<SignOut
				confirm="Log out?"
				ariaLabel="Sign out"
				title="Sign out"
				class="shrink-0 rounded-md p-1.5 text-gray-400 transition hover:bg-black/5 hover:text-gray-700 dark:text-neutral-500 dark:hover:bg-white/5 dark:hover:text-neutral-300"
			>
				<svg viewBox="0 0 20 20" fill="currentColor" class="size-5" aria-hidden="true">
					<path
						fill-rule="evenodd"
						d="M3 4.25A2.25 2.25 0 0 1 5.25 2h5.5A2.25 2.25 0 0 1 13 4.25v2a.75.75 0 0 1-1.5 0v-2a.75.75 0 0 0-.75-.75h-5.5a.75.75 0 0 0-.75.75v11.5c0 .414.336.75.75.75h5.5a.75.75 0 0 0 .75-.75v-2a.75.75 0 0 1 1.5 0v2A2.25 2.25 0 0 1 10.75 18h-5.5A2.25 2.25 0 0 1 3 15.75V4.25Z"
						clip-rule="evenodd"
					/>
					<path
						fill-rule="evenodd"
						d="M19 10a.75.75 0 0 0-.75-.75H8.704l1.048-.943a.75.75 0 1 0-1.004-1.114l-2.5 2.25a.75.75 0 0 0 0 1.114l2.5 2.25a.75.75 0 1 0 1.004-1.114l-1.048-.943h9.546A.75.75 0 0 0 19 10Z"
						clip-rule="evenodd"
					/>
				</svg>
			</SignOut>
		</div>
	</div>
{/snippet}

{#if mobile}
	<!-- Mobile drawer: brand → search → nav → user → rule → manifesto text. -->
	<div
		class="flex h-full min-h-screen w-72 flex-col overflow-y-auto border-r border-black/10 bg-stone-50 px-5 py-6 dark:border-white/10 dark:bg-neutral-900"
	>
		<div class="mb-6">{@render brand()}</div>
		<div>{@render search()}</div>
		<div class="mt-5 border-t border-black/10 pt-5 dark:border-white/10">{@render navLinks()}</div>
		<div class="mt-5 border-t border-black/10 pt-4 dark:border-white/10">{@render userArea()}</div>
		<hr class="my-6 border-black/10 dark:border-white/10" />
		{@render blurb()}
	</div>
{:else}
	<!-- Desktop: brand → manifesto text → (spacer) → search → nav → user. -->
	<div
		class="flex h-full min-h-screen w-72 flex-col overflow-y-auto border-r border-black/10 bg-stone-50 px-5 py-6 dark:border-white/10 dark:bg-neutral-900"
	>
		<div class="mb-6">{@render brand()}</div>
		{@render blurb()}
		<div class="flex-1"></div>
		<div class="mt-8 border-t border-black/10 pt-5 dark:border-white/10">{@render search()}</div>
		<div class="mt-5 border-t border-black/10 pt-5 dark:border-white/10">{@render navLinks()}</div>
		<div class="mt-5 border-t border-black/10 pt-4 dark:border-white/10">{@render userArea()}</div>
	</div>
{/if}
