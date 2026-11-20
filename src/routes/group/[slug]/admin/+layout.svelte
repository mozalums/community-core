<script lang="ts">
	import { page } from '$app/stores';
	import { groupBase } from '$lib/group-nav';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	const { data, children }: { data: LayoutData; children: Snippet } = $props();
	const base = $derived(groupBase($page.url.pathname, data.group.slug));

	type NavItem = { href: string; label: string; icon: string };
	const items = $derived<NavItem[]>([
		{ href: `${base}/admin`, label: 'Overview', icon: 'overview' },
		{ href: `${base}/admin/requests`, label: 'Requests', icon: 'requests' },
		{ href: `${base}/admin/import`, label: 'Import roster', icon: 'import' },
		{ href: `${base}/admin/landing`, label: 'Landing page', icon: 'landing' },
		{ href: `${base}/admin/access`, label: 'Admin access', icon: 'access' },
		{ href: `${base}/admin/audit`, label: 'Audit trail', icon: 'audit' }
	]);

	// Overview matches its path exactly so it doesn't also light up on sub-pages;
	// sub-pages match themselves plus any deeper segments.
	function isActive(href: string): boolean {
		const p = $page.url.pathname;
		if (href === `${base}/admin`) return p === `${base}/admin`;
		return p === href || p.startsWith(`${href}/`);
	}
</script>

<div class="flex flex-col gap-6 md:flex-row md:gap-8">
	<aside class="md:w-52 md:shrink-0">
		<p
			class="px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-neutral-500"
		>
			Admin
		</p>
		<nav class="flex flex-col gap-0.5">
			{#each items as item (item.href)}
				{@const active = isActive(item.href)}
				<a
					href={item.href}
					aria-current={active ? 'page' : undefined}
					class={'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition ' +
						(active
							? 'bg-gray-100 font-medium text-gray-900 dark:bg-white/10 dark:text-neutral-100'
							: 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100')}
				>
					{@render navIcon(item.icon)}
					{item.label}
				</a>
			{/each}
		</nav>
	</aside>

	<div class="min-w-0 flex-1">
		{@render children()}
	</div>
</div>

<!-- Heroicons (mini, 20×20) for the admin nav, in light grey. -->
{#snippet navIcon(name: string)}
	{#if name === 'overview'}
		<svg
			viewBox="0 0 20 20"
			fill="currentColor"
			class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
			aria-hidden="true"
		>
			<path
				fill-rule="evenodd"
				d="M4.25 2A2.25 2.25 0 0 0 2 4.25v2.5A2.25 2.25 0 0 0 4.25 9h2.5A2.25 2.25 0 0 0 9 6.75v-2.5A2.25 2.25 0 0 0 6.75 2h-2.5Zm0 9A2.25 2.25 0 0 0 2 13.25v2.5A2.25 2.25 0 0 0 4.25 18h2.5A2.25 2.25 0 0 0 9 15.75v-2.5A2.25 2.25 0 0 0 6.75 11h-2.5Zm9-9A2.25 2.25 0 0 0 11 4.25v2.5A2.25 2.25 0 0 0 13.25 9h2.5A2.25 2.25 0 0 0 18 6.75v-2.5A2.25 2.25 0 0 0 15.75 2h-2.5Zm0 9A2.25 2.25 0 0 0 11 13.25v2.5A2.25 2.25 0 0 0 13.25 18h2.5A2.25 2.25 0 0 0 18 15.75v-2.5A2.25 2.25 0 0 0 15.75 11h-2.5Z"
				clip-rule="evenodd"
			/>
		</svg>
	{:else if name === 'requests'}
		<svg
			viewBox="0 0 20 20"
			fill="currentColor"
			class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
			aria-hidden="true"
		>
			<path
				fill-rule="evenodd"
				d="M1 11.27c0-.246.033-.492.099-.73l1.523-5.521A2.75 2.75 0 0 1 5.273 3h9.454a2.75 2.75 0 0 1 2.651 2.019l1.523 5.52c.066.239.099.485.099.732V15a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2v-3.73Zm3.068-5.852A1.25 1.25 0 0 1 5.273 4.5h9.454a1.25 1.25 0 0 1 1.205.918l1.523 5.52c.006.02.01.041.015.062H14a1 1 0 0 0-.86.49l-.606 1.02a1 1 0 0 1-.86.49H8.236a1 1 0 0 1-.894-.553l-.448-.894A1 1 0 0 0 6 11H2.53l.015-.062 1.523-5.52Z"
				clip-rule="evenodd"
			/>
		</svg>
	{:else if name === 'landing'}
		<svg
			viewBox="0 0 20 20"
			fill="currentColor"
			class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
			aria-hidden="true"
		>
			<path
				fill-rule="evenodd"
				d="M4.5 2A1.5 1.5 0 0 0 3 3.5v13A1.5 1.5 0 0 0 4.5 18h11a1.5 1.5 0 0 0 1.5-1.5V7.621a1.5 1.5 0 0 0-.44-1.06l-4.12-4.122A1.5 1.5 0 0 0 11.378 2H4.5Zm2.25 8.5a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5h-6.5Zm0 3a.75.75 0 0 0 0 1.5h6.5a.75.75 0 0 0 0-1.5h-6.5Z"
				clip-rule="evenodd"
			/>
		</svg>
	{:else if name === 'import'}
		<svg
			viewBox="0 0 20 20"
			fill="currentColor"
			class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
			aria-hidden="true"
		>
			<path
				d="M9.25 13.25a.75.75 0 0 0 1.5 0V4.636l2.955 3.129a.75.75 0 0 0 1.09-1.03l-4.25-4.5a.75.75 0 0 0-1.09 0l-4.25 4.5a.75.75 0 1 0 1.09 1.03L9.25 4.636v8.614Z"
			/>
			<path
				d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z"
			/>
		</svg>
	{:else if name === 'audit'}
		<svg
			viewBox="0 0 20 20"
			fill="currentColor"
			class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
			aria-hidden="true"
		>
			<path
				fill-rule="evenodd"
				d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-13a.75.75 0 0 0-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 0 0 0-1.5h-3.25V5Z"
				clip-rule="evenodd"
			/>
		</svg>
	{:else if name === 'access'}
		<svg
			viewBox="0 0 20 20"
			fill="currentColor"
			class="size-4 shrink-0 text-gray-400 dark:text-neutral-500"
			aria-hidden="true"
		>
			<path
				fill-rule="evenodd"
				d="M8 7a5 5 0 1 1 3.61 4.804l-1.903 1.903A1 1 0 0 1 9 14H8v1a1 1 0 0 1-1 1H6v1a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-2a1 1 0 0 1 .293-.707L8.196 8.39A5.002 5.002 0 0 1 8 7Zm5-3a.75.75 0 0 0 0 1.5A1.5 1.5 0 0 1 14.5 7 .75.75 0 0 0 16 7a3 3 0 0 0-3-3Z"
				clip-rule="evenodd"
			/>
		</svg>
	{/if}
{/snippet}
