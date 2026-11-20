<script lang="ts">
	import { page } from '$app/stores';
	import NavSearch from '$lib/components/NavSearch.svelte';
	import SignOut from '$lib/components/SignOut.svelte';
	import { brand, site } from '$skin/skin.yaml';

	type Props = {
		// Group's landing href ('/' for the clean default-group URL).
		home: string;
		// Link base for the current request ('' for clean URLs).
		base: string;
		// Group display name — used for the logo's alt text.
		groupName: string;
		// Membership / role / auth flags from the layout data.
		member?: boolean;
		isGroupAdmin?: boolean;
		signedIn?: boolean;
		// Where "Sign in" should point (group-aware, from signInHref()).
		signInHref: string;
		// The signed-in member's own profile URL, when they have one.
		profileHref?: string;
	};

	const {
		home,
		base,
		groupName,
		member = false,
		isGroupAdmin = false,
		signedIn = false,
		signInHref,
		profileHref
	}: Props = $props();

	let open = $state(false);

	const currentPath = $derived($page.url.pathname);

	type Item = { href: string; label: string; icon: string };

	// Links are computed from the layout flags so the menu always mirrors the
	// header it replaced — Directory for members, the member's own Profile,
	// Admin for group admins, and Sign in for a guest. Each carries a Heroicon
	// name rendered by the {navIcon} snippet below. Sign-out is not a link: it
	// posts a form, so it is rendered after the list rather than in it.
	const items = $derived<Item[]>([
		...(member ? [{ href: `${base}/members`, label: 'Directory', icon: 'directory' }] : []),
		...(profileHref ? [{ href: profileHref, label: 'Profile', icon: 'profile' }] : []),
		...(isGroupAdmin ? [{ href: `${base}/admin`, label: 'Admin', icon: 'admin' }] : []),
		...(signedIn ? [] : [{ href: signInHref, label: 'Sign in', icon: 'signin' }])
	]);

	function close() {
		open = false;
	}
</script>

<header
	class="sticky top-0 z-30 flex items-center gap-3 border-b border-black/10 bg-white/90 px-4 py-3 backdrop-blur dark:border-white/10 dark:bg-neutral-900/90"
>
	<a href={home} class="inline-flex shrink-0 items-center" aria-label="{groupName} — home">
		<img src="/{brand.wordmark}" alt={site.name} class="h-7 w-auto dark:invert" />
	</a>

	{#if member}
		<NavSearch {base} />
	{:else}
		<div class="flex-1"></div>
	{/if}

	<!-- Hamburger trigger -->
	<button
		type="button"
		onclick={() => (open = !open)}
		aria-label={open ? 'Close menu' : 'Open menu'}
		aria-expanded={open}
		class="-mr-1 shrink-0 rounded-full p-2 text-gray-500 transition hover:bg-black/5 hover:text-black dark:text-neutral-400 dark:hover:bg-white/5 dark:hover:text-neutral-100"
	>
		{#if open}
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 16 16"
				fill="currentColor"
				class="size-5"
				aria-hidden="true"
			>
				<path
					fill-rule="evenodd"
					d="M3.22 3.22a.75.75 0 0 1 1.06 0L8 6.94l3.72-3.72a.75.75 0 1 1 1.06 1.06L9.06 8l3.72 3.72a.75.75 0 1 1-1.06 1.06L8 9.06l-3.72 3.72a.75.75 0 0 1-1.06-1.06L6.94 8 3.22 4.28a.75.75 0 0 1 0-1.06Z"
					clip-rule="evenodd"
				/>
			</svg>
		{:else}
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 16 16"
				fill="currentColor"
				class="size-5"
				aria-hidden="true"
			>
				<path
					fill-rule="evenodd"
					d="M2 4.75A.75.75 0 0 1 2.75 4h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 4.75ZM2 8a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75A.75.75 0 0 1 2 8Zm0 3.25a.75.75 0 0 1 .75-.75h10.5a.75.75 0 0 1 0 1.5H2.75a.75.75 0 0 1-.75-.75Z"
					clip-rule="evenodd"
				/>
			</svg>
		{/if}
	</button>
</header>

<!-- Heroicons (mini, 20×20) for each dropdown option, rendered in light grey. -->
{#snippet navIcon(name: string)}
	{#if name === 'directory'}
		<svg
			viewBox="0 0 20 20"
			fill="currentColor"
			class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
			aria-hidden="true"
		>
			<path
				d="M7 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM14.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM1.615 16.428a1.224 1.224 0 0 1-.569-1.175 6.002 6.002 0 0 1 11.908 0c.058.467-.172.92-.57 1.174A9.953 9.953 0 0 1 7 18a9.953 9.953 0 0 1-5.385-1.572ZM14.5 16h-.106c.07-.297.088-.611.048-.933a7.47 7.47 0 0 0-1.588-3.755 4.502 4.502 0 0 1 5.874 2.636.818.818 0 0 1-.36.98A7.465 7.465 0 0 1 14.5 16Z"
			/>
		</svg>
	{:else if name === 'profile'}
		<svg
			viewBox="0 0 20 20"
			fill="currentColor"
			class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
			aria-hidden="true"
		>
			<path
				fill-rule="evenodd"
				d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-5.5-2.5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0ZM10 12a5.99 5.99 0 0 0-4.793 2.39A6.483 6.483 0 0 0 10 16.5a6.483 6.483 0 0 0 4.793-2.11A5.99 5.99 0 0 0 10 12Z"
				clip-rule="evenodd"
			/>
		</svg>
	{:else if name === 'admin'}
		<svg
			viewBox="0 0 20 20"
			fill="currentColor"
			class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
			aria-hidden="true"
		>
			<path
				fill-rule="evenodd"
				d="M7.84 1.804A1 1 0 0 1 8.82 1h2.36a1 1 0 0 1 .98.804l.331 1.652a6.993 6.993 0 0 1 1.929 1.115l1.598-.54a1 1 0 0 1 1.186.447l1.18 2.044a1 1 0 0 1-.205 1.251l-1.267 1.113a7.047 7.047 0 0 1 0 2.228l1.267 1.113a1 1 0 0 1 .206 1.25l-1.18 2.045a1 1 0 0 1-1.187.447l-1.598-.54a6.993 6.993 0 0 1-1.929 1.115l-.33 1.652a1 1 0 0 1-.98.804H8.82a1 1 0 0 1-.98-.804l-.331-1.652a6.993 6.993 0 0 1-1.929-1.115l-1.598.54a1 1 0 0 1-1.186-.447l-1.18-2.044a1 1 0 0 1 .205-1.251l1.267-1.114a7.05 7.05 0 0 1 0-2.227L1.821 7.773a1 1 0 0 1-.206-1.25l1.18-2.045a1 1 0 0 1 1.187-.447l1.598.54A6.992 6.992 0 0 1 7.51 3.456l.33-1.652ZM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
				clip-rule="evenodd"
			/>
		</svg>
	{:else if name === 'signout'}
		<svg
			viewBox="0 0 20 20"
			fill="currentColor"
			class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
			aria-hidden="true"
		>
			<path
				fill-rule="evenodd"
				d="M3 4.25A2.25 2.25 0 0 1 5.25 2h5.5A2.25 2.25 0 0 1 13 4.25v2a.75.75 0 0 1-1.5 0v-2a.75.75 0 0 0-.75-.75h-5.5a.75.75 0 0 0-.75.75v11.5c0 .414.336.75.75.75h5.5a.75.75 0 0 0 .75-.75v-2a.75.75 0 0 1 1.5 0v2A2.25 2.25 0 0 1 10.75 18h-5.5A2.25 2.25 0 0 1 3 15.75V4.25Z"
				clip-rule="evenodd"
			/>
			<path
				fill-rule="evenodd"
				d="M6 10a.75.75 0 0 1 .75-.75h9.546l-1.048-.943a.75.75 0 1 1 1.004-1.114l2.5 2.25a.75.75 0 0 1 0 1.114l-2.5 2.25a.75.75 0 1 1-1.004-1.114l1.048-.943H6.75A.75.75 0 0 1 6 10Z"
				clip-rule="evenodd"
			/>
		</svg>
	{:else if name === 'signin'}
		<svg
			viewBox="0 0 20 20"
			fill="currentColor"
			class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
			aria-hidden="true"
		>
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
	{/if}
{/snippet}

{#if open}
	<!-- Transparent click-catcher (no page dimming) so an outside tap/click
	     closes the menu, the way a normal dropdown does. Below the panel. -->
	<button
		type="button"
		aria-label="close menu"
		class="fixed inset-0 z-40 cursor-default"
		onclick={close}
	></button>

	<nav
		class="fixed right-2 top-14 z-50 min-w-[180px] overflow-hidden rounded-lg bg-white text-gray-700 shadow-lg ring-1 ring-black/5 dark:bg-neutral-900 dark:text-neutral-300 dark:ring-white/10"
		aria-label="Page menu"
	>
		<ul class="py-1">
			{#each items as item (item.href)}
				{@const active = currentPath === item.href || currentPath.startsWith(item.href + '/')}
				<li>
					<a
						href={item.href}
						onclick={close}
						class={'flex items-center gap-2.5 px-4 py-2 text-sm transition ' +
							(active
								? 'bg-gray-100 font-medium text-black dark:bg-white/10 dark:text-neutral-100'
								: 'text-gray-700 hover:bg-gray-100 hover:text-black dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-neutral-100')}
					>
						{@render navIcon(item.icon)}
						{item.label}
					</a>
				</li>
			{/each}
			{#if signedIn}
				<li>
					<SignOut
						onclick={close}
						class="flex w-full items-center gap-2.5 px-4 py-2 text-sm text-gray-700 transition hover:bg-gray-100 hover:text-black dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-neutral-100"
					>
						{@render navIcon('signout')}
						Sign out
					</SignOut>
				</li>
			{/if}
		</ul>
	</nav>
{/if}
