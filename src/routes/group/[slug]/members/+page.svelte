<script lang="ts">
	import { page } from '$app/stores';
	import { SvelteSet } from 'svelte/reactivity';
	import Gravatar from '$lib/components/Gravatar.svelte';
	import NavSearch from '$lib/components/NavSearch.svelte';
	import { groupBase } from '$lib/group-nav';
	import type { PageData } from './$types';

	const { data }: { data: PageData } = $props();
	const base = $derived(groupBase($page.url.pathname, data.group.slug));

	// Local star state for optimistic toggles. Seeded from the server on every
	// load (search / filter / navigation); a click flips it immediately and the
	// persist happens in the background (reverts on failure).
	const starred = new SvelteSet<string>();
	$effect(() => {
		starred.clear();
		for (const m of data.members) if (m.starred) starred.add(m.id);
	});

	async function toggleStar(id: string) {
		const was = starred.has(id);
		if (was) starred.delete(id);
		else starred.add(id);
		try {
			const res = await fetch(`${base}/members/${id}/star`, { method: was ? 'DELETE' : 'POST' });
			if (!res.ok) throw new Error('star request failed');
		} catch {
			// Revert the optimistic change.
			if (was) starred.add(id);
			else starred.delete(id);
		}
	}
</script>

<section class="space-y-6">
	<!-- Search lives in the sidebar on desktop; surface it at the top on mobile. -->
	<div class="md:hidden">
		<NavSearch {base} />
	</div>

	<div class="flex items-baseline justify-between gap-4">
		<h1 class="text-2xl font-bold">{data.starredView ? 'Starred People' : 'Directory'}</h1>
		<span class="flex items-center gap-1.5 text-sm text-gray-500 dark:text-neutral-400">
			<span>
				{data.count}{data.filtered ? ' matched' : ''}
				{data.count === 1 ? 'member' : 'members'}
			</span>
			{#if data.filtered}
				<a
					href={data.starredView ? `${base}/members?starred=1` : `${base}/members`}
					aria-label="Clear search"
					title="Clear search"
					class="text-gray-400 transition hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-400"
				>
					<svg viewBox="0 0 20 20" fill="currentColor" class="size-4" aria-hidden="true">
						<path
							d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"
						/>
					</svg>
				</a>
			{/if}
		</span>
	</div>

	{#if data.relaxed}
		<p class="text-sm text-gray-500 dark:text-neutral-400">
			Nobody matches all of <span class="font-medium text-black dark:text-neutral-100"
				>{data.query.q}</span
			>, so these match part of it.
		</p>
	{/if}

	{#if data.members.length}
		<ul class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.members as m (m.id)}
				<li
					class="relative rounded-lg border border-gray-200 bg-white transition hover:border-gray-300 hover:shadow-sm dark:border-white/10 dark:bg-neutral-900 dark:hover:border-white/20"
				>
					<a href={`${base}/members/${m.id}`} class="flex items-center gap-3 p-3">
						<Gravatar hash={m.gravatarHash} name={m.name} size={40} avatarId={m.avatarId} />
						<div class="min-w-0 flex-1">
							<p class="truncate font-medium text-black dark:text-neutral-100">
								{m.name ?? 'Unnamed member'}
							</p>
							{#if m.city}
								<p class="truncate text-sm text-gray-500 dark:text-neutral-400">{m.city}</p>
							{/if}
						</div>
						<!-- keep text clear of the corner star -->
						<span class="w-5 shrink-0"></span>
					</a>
					<button
						type="button"
						onclick={() => toggleStar(m.id)}
						aria-pressed={starred.has(m.id)}
						aria-label={starred.has(m.id) ? 'Unstar' : 'Star'}
						title={starred.has(m.id) ? 'Starred' : 'Star'}
						class="absolute bottom-2.5 right-2.5 rounded p-0.5 transition {starred.has(m.id)
							? 'text-yellow-400'
							: 'text-gray-300 hover:text-gray-400 dark:text-neutral-600 dark:hover:text-neutral-500'}"
					>
						<svg
							viewBox="0 0 24 24"
							fill={starred.has(m.id) ? 'currentColor' : 'none'}
							stroke="currentColor"
							stroke-width="1.5"
							class="size-5"
							aria-hidden="true"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.884a.563.563 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"
							/>
						</svg>
					</button>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-gray-500 dark:text-neutral-400">
			{#if data.starredView}
				You haven't starred anyone yet. Tap the star on a member to add them here.
			{:else if data.filtered}
				No members match that search.
			{:else}
				No members yet.
			{/if}
		</p>
	{/if}
</section>
