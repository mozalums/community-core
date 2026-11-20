<script lang="ts">
	import { page } from '$app/stores';
	import { groupBase } from '$lib/group-nav';
	import SignOut from '$lib/components/SignOut.svelte';

	// Error boundary for the whole group subtree. Layout loads throw past their
	// own directory, so this is where the admin gate's 403 lands.
	const group = $derived($page.data.group);
	const base = $derived(group ? groupBase($page.url.pathname, group.slug) : '');
	const email = $derived($page.data.user?.email ?? null);

	// A permission failure is the one status where the account is the answer: the
	// visitor is signed in as somebody, just not as somebody allowed in here.
	const wrongAccount = $derived($page.status === 403 && !!email);

	const backHref = $derived($page.data.member ? `${base}/members` : base || '/');
	const backLabel = $derived($page.data.member ? 'Back to the directory' : 'Back to the home page');

	// Signing out is only useful here if it leads somewhere: the login modal,
	// with the refused destination preserved so an admin lands back on it.
	const afterSignOut = $derived(`/?login=1&next=${encodeURIComponent($page.url.pathname)}`);
</script>

<svelte:head>
	<title>{$page.status} — {group?.name ?? 'Error'}</title>
</svelte:head>

<section
	class="mx-auto max-w-lg space-y-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-neutral-900"
>
	<h1 class="text-xl font-bold">
		{wrongAccount ? 'Group admins only' : ($page.error?.message ?? 'Something went wrong')}
	</h1>

	{#if wrongAccount}
		<p class="text-sm text-gray-600 dark:text-neutral-400">
			You are signed in as <span class="font-medium text-gray-800 dark:text-neutral-200"
				>{email}</span
			>, which is not an admin of {group?.name ?? 'this community'}.
		</p>
		<p class="text-sm text-gray-600 dark:text-neutral-400">
			You are still signed in everywhere else. Sign out only if you meant to use a different
			account.
		</p>
	{:else}
		<p class="text-sm text-gray-600 dark:text-neutral-400">
			{$page.status === 404 ? 'That page does not exist.' : 'The page could not be shown.'}
		</p>
	{/if}

	<div class="flex flex-wrap items-center gap-3 pt-2">
		<a
			href={backHref}
			class="rounded-md bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-black dark:bg-white/10 dark:hover:bg-white/20"
		>
			{backLabel}
		</a>
		{#if email}
			<SignOut
				redirectTo={wrongAccount ? afterSignOut : undefined}
				class="rounded-md px-3 py-2 text-sm text-gray-600 underline underline-offset-2 hover:text-gray-900 dark:text-neutral-400 dark:hover:text-neutral-200"
			>
				Sign out
			</SignOut>
		{/if}
	</div>
</section>
