<script lang="ts">
	import { page } from '$app/stores';
	import MemberTile from '$lib/components/MemberTile.svelte';
	import NavSearch from '$lib/components/NavSearch.svelte';
	import { groupBase } from '$lib/group-nav';
	import type { PageData } from './$types';

	const { data }: { data: PageData } = $props();
	const base = $derived(groupBase($page.url.pathname, data.group.slug));
	const filterText = $derived(data.filters.map((f) => `${f.label}: ${f.value}`).join(', '));
</script>

<section class="space-y-6">
	<!-- Search lives in the sidebar on desktop; surface it at the top on mobile. -->
	<div class="md:hidden">
		<NavSearch {base} />
	</div>

	<div class="flex items-baseline justify-between gap-4">
		<h1 class="text-2xl font-bold">
			{data.starredView
				? 'Starred People'
				: data.filters.length
					? 'Filtered Directory'
					: 'Directory'}
		</h1>
		<span class="flex items-center gap-1.5 text-sm text-gray-500 dark:text-neutral-400">
			<span>
				{data.count}{data.filtered ? ' matched' : ''}
				{data.count === 1 ? 'member' : 'members'}
			</span>
			{#if data.filtered || data.unsearchable}
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

	{#if data.filters.length}
		<ul class="flex flex-wrap gap-2" aria-label="Filters">
			{#each data.filters as f (f.label)}
				<li
					class="flex items-center gap-1 rounded-full border border-gray-300 bg-gray-50 py-0.5 pl-3 pr-1 text-sm text-gray-700 dark:border-white/15 dark:bg-white/5 dark:text-neutral-300"
				>
					<span>{f.label}: <span class="font-medium">{f.value}</span></span>
					<a
						href={`${base}/members${f.without}`}
						aria-label={`Remove filter ${f.label}: ${f.value}`}
						title="Remove filter"
						class="rounded-full p-0.5 text-gray-400 transition hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-400"
					>
						<svg viewBox="0 0 20 20" fill="currentColor" class="size-4" aria-hidden="true">
							<path
								d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"
							/>
						</svg>
					</a>
				</li>
			{/each}
		</ul>
	{/if}

	{#if data.unsearchable}
		<p class="text-sm text-gray-500 dark:text-neutral-400">
			<span class="font-medium text-black dark:text-neutral-100">{data.query.q}</span> has no
			searchable words, so {data.filters.length ? 'only the filters apply' : 'this is everyone'}.
		</p>
	{:else if data.fuzzy}
		<p class="text-sm text-gray-500 dark:text-neutral-400">
			Nobody matches {data.relaxed ? 'any of' : ''}
			<span class="font-medium text-black dark:text-neutral-100">{data.query.q}</span> as typed, so
			these are close spellings{data.relaxed ? ' of part of it' : ''}.
		</p>
	{:else if data.relaxed}
		<p class="text-sm text-gray-500 dark:text-neutral-400">
			Nobody matches all of <span class="font-medium text-black dark:text-neutral-100"
				>{data.query.q}</span
			>, so these match part of it.
		</p>
	{/if}

	{#if data.members.length}
		<ul class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
			{#each data.members as m (m.id)}
				<MemberTile member={m} href={`${base}/members/${m.ref}`} {base} starred={m.starred} />
			{/each}
		</ul>
	{:else}
		<p class="text-gray-500 dark:text-neutral-400">
			{#if data.filters.length}
				No {data.starredView ? 'starred ' : ''}members match {filterText}{data.query.q &&
				!data.unsearchable
					? ` and “${data.query.q}”`
					: ''}.
			{:else if data.starredView}
				You haven't starred anyone yet. Tap the star on a member to add them here.
			{:else if data.filtered}
				No members match that search.
			{:else}
				No members yet.
			{/if}
		</p>
	{/if}
</section>
