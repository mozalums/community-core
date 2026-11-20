<script lang="ts">
	import { navigating, page } from '$app/stores';
	import Spinner from '$lib/components/Spinner.svelte';
	import type { PageData } from './$types';

	const { data }: { data: PageData } = $props();

	// The filter is a GET form, so "pending" is a navigation in flight to this
	// same page: the button spins and locks until the new list lands.
	const pending = $derived($navigating?.to?.url.pathname === $page.url.pathname);

	function pageHref(n: number): string {
		const q = new URLSearchParams($page.url.searchParams);
		q.set('page', String(n));
		return `?${q}`;
	}

	const when = (iso: string) => new Date(iso).toLocaleString();

	// The writer already caps what it stores, so the reader shows all of it:
	// a long value collapses behind a preview rather than being cut, or two
	// values sharing a long prefix would render identically. Strings are
	// quoted and every full view keeps its whitespace, so distinct stored
	// values never read the same: landing text "null" is not a missing page
	// (null), and "a\nb" is not "a b".
	const PREVIEW = 160;
	const text = (v: unknown): string =>
		v === undefined
			? '(none)'
			: typeof v === 'string'
				? `"${v}"`
				: (JSON.stringify(v) ?? String(v));

	type Change = { key: string; before: unknown; after: unknown };
	function changes(
		before: Record<string, unknown> | null,
		after: Record<string, unknown> | null
	): Change[] {
		const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])];
		const own = (o: Record<string, unknown> | null, key: string) =>
			o && Object.hasOwn(o, key) ? o[key] : undefined;
		return keys.map((key) => ({ key, before: own(before, key), after: own(after, key) }));
	}
</script>

<svelte:head>
	<title>Audit trail — {data.group.name}</title>
</svelte:head>

<section class="space-y-4">
	<div class="flex items-baseline justify-between">
		<h1 class="text-2xl font-bold">Audit trail</h1>
		<span class="text-sm text-gray-500 dark:text-neutral-400">Page {data.page}</span>
	</div>

	<form method="GET" class="flex flex-wrap items-end gap-2" data-sveltekit-keepfocus>
		<label class="text-sm">
			<span class="block text-gray-500 dark:text-neutral-400">Category</span>
			<select
				name="category"
				value={data.filter.category}
				class="rounded-md border-gray-300 text-sm dark:border-neutral-600 dark:bg-neutral-900"
			>
				<option value="">All</option>
				{#each data.categories as c (c)}
					<option value={c}>{c}</option>
				{/each}
			</select>
		</label>
		<label class="text-sm">
			<span class="block text-gray-500 dark:text-neutral-400">Target email</span>
			<input
				type="email"
				name="email"
				value={data.filter.email}
				placeholder="someone@example.com"
				class="rounded-md border-gray-300 text-sm dark:border-neutral-600 dark:bg-neutral-900"
			/>
		</label>
		<button
			disabled={pending}
			class="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
		>
			{#if pending}<Spinner />{/if}
			Filter
		</button>
	</form>

	{#if data.blocks.length === 0}
		<p
			class="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-400"
		>
			No recorded events{data.filter.category || data.filter.email ? ' match this filter' : ''}.
		</p>
	{:else}
		<ul class="space-y-3">
			{#each data.blocks as block (block.rows[0].id)}
				<li
					class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-neutral-900"
				>
					{#if block.rows.length > 1}
						<details>
							<summary class="cursor-pointer">
								{@render head(block.rows[0])}
								<span class="text-sm text-gray-500 dark:text-neutral-400">
									+{block.rows.length - 1} more in this run
								</span>
							</summary>
							<ul class="mt-3 space-y-2 border-l border-gray-200 pl-3 dark:border-white/10">
								{#each block.rows.slice(1) as r (r.id)}
									<li>{@render head(r)}{@render body(r)}</li>
								{/each}
							</ul>
						</details>
						{@render body(block.rows[0])}
					{:else}
						{@render head(block.rows[0])}
						{@render body(block.rows[0])}
					{/if}
				</li>
			{/each}
		</ul>
	{/if}

	<nav class="flex justify-between text-sm">
		{#if data.page > 1}
			<a href={pageHref(data.page - 1)} class="text-link hover:underline"
				>Newer</a
			>
		{:else}<span></span>{/if}
		{#if data.hasMore}
			<a href={pageHref(data.page + 1)} class="text-link hover:underline"
				>Older</a
			>
		{/if}
	</nav>
</section>

{#snippet head(r: PageData['blocks'][number]['rows'][number])}
	<span class="inline-flex flex-wrap items-baseline gap-x-2">
		<span class="font-medium">{r.action}</span>
		<span
			class="rounded bg-gray-100 px-1.5 text-xs text-gray-600 dark:bg-white/10 dark:text-neutral-300"
			>{r.category}</span
		>
		{#if r.targetEmail}<span class="text-sm">{r.targetEmail}</span>{/if}
		<span class="text-sm text-gray-500 dark:text-neutral-400">
			by {r.actor ?? 'unknown'} · {when(r.at)}
		</span>
	</span>
{/snippet}

{#snippet body(r: PageData['blocks'][number]['rows'][number])}
	{@const diff = changes(r.before, r.after)}
	{#if diff.length}
		<dl class="mt-2 space-y-0.5 text-sm">
			{#each diff as c (c.key)}
				<div class="flex min-w-0 gap-2">
					<dt class="shrink-0 text-gray-500 dark:text-neutral-400">{c.key}:</dt>
					<dd class="min-w-0 break-words text-gray-800 dark:text-neutral-200">
						{@render value(c.before)} &gt; {@render value(c.after)}
					</dd>
				</div>
			{/each}
		</dl>
	{/if}
	{#if Object.keys(r.meta).length}
		<div class="mt-1 break-words text-xs text-gray-500 dark:text-neutral-400">
			{@render value(r.meta)}
		</div>
	{/if}
{/snippet}

{#snippet value(v: unknown)}
	{@const s = text(v)}
	{#if s.length > PREVIEW}
		<details class="my-0.5">
			<summary class="cursor-pointer"
				>{s.slice(0, PREVIEW)}…
				<span class="text-xs text-link">({s.length} chars, show all)</span
				></summary
			>
			<pre
				class="mt-1 whitespace-pre-wrap break-words rounded bg-gray-50 p-2 font-sans dark:bg-white/5">{s}</pre>
		</details>
	{:else}<span class="whitespace-pre-wrap">{s}</span>{/if}
{/snippet}
