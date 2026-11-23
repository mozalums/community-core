<script lang="ts">
	import { page } from '$app/stores';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import Gravatar from '$lib/components/Gravatar.svelte';
	import { splitBioLinks } from '$lib/bio-links';
	import StarButton from '$lib/components/StarButton.svelte';
	import SiteIcon from '$lib/components/SiteIcon.svelte';
	import type { RenderedLink } from '$lib/links';
	import { groupBase } from '$lib/group-nav';
	import type { PageData } from './$types';

	const { data }: { data: PageData } = $props();
	const base = $derived(groupBase($page.url.pathname, data.group.slug));

	const p = $derived(data.profile);
	const bioSegments = $derived(p.bio ? splitBioLinks(p.bio) : []);

	// A URL shown as its bare address (no protocol/www), linking to itself.
	const urlDisplay = (u: string) =>
		u
			.replace(/^https?:\/\//, '')
			.replace(/^www\./, '')
			.replace(/\/+$/, '');

	// Link to the directory searching for `term`.
	const searchHref = (term: string) => `${base}/members?q=${encodeURIComponent(term)}`;
	// Link to the directory filtered on a field, from the query the server built.
	const filterHref = (query: string) => `${base}/members?${query}`;

	type Entry = { main: string; pills: string[] };

	// Split a list into entries on top-level `,` and `;` (commas inside
	// parentheses are kept), then peel a trailing "(a, b)" qualifier off each
	// entry into pills — e.g. "2011 - 2024 (Staff); 2005 - Today (Volunteer)" →
	// two entries, each with one pill. Entries without a qualifier just have [].
	function parseEntries(raw: string | null): Entry[] {
		if (!raw) return [];
		const parts: string[] = [];
		let depth = 0;
		let cur = '';
		for (const ch of raw) {
			if (ch === '(') depth += 1;
			else if (ch === ')') depth = Math.max(0, depth - 1);
			if ((ch === ',' || ch === ';') && depth === 0) {
				parts.push(cur);
				cur = '';
			} else {
				cur += ch;
			}
		}
		parts.push(cur);
		return parts
			.map((part) => {
				const m = part.trim().match(/^(.*?)\s*\(([^)]*)\)\s*$/);
				if (m) {
					return {
						main: m[1].trim(),
						pills: m[2]
							.split(',')
							.map((x) => x.trim())
							.filter(Boolean)
					};
				}
				return { main: part.trim(), pills: [] };
			})
			.filter((e) => e.main || e.pills.length);
	}

	type Detail = {
		key: string;
		label: string;
		tokens?: string[];
		entries?: Entry[];
		href?: string;
		text?: string;
		filter?: string;
		links?: RenderedLink[];
		sep: string;
	};

	// Labeled rows in the order the server sent them, which is the field schema's.
	// A list field parses into entries whose parenthetical qualifiers render as
	// clickable pills; a URL renders as a link where the server vouched for it
	// and as plain text where it did not; anything else is one clickable token,
	// linking to the field's filter where the server sent one and to a search
	// otherwise.
	const details = $derived(
		p.details.map((d): Detail => {
			if (d.type === 'tags') {
				return {
					key: d.key,
					label: d.label,
					entries: (d.tags ?? []).map((a) => ({ main: a, pills: [] })),
					sep: ', '
				};
			}
			if (d.type === 'links') {
				return { key: d.key, label: d.label, links: d.links ?? [], sep: '' };
			}
			if (d.type === 'list') {
				return { key: d.key, label: d.label, entries: parseEntries(d.value), sep: ', ' };
			}
			if (d.type === 'url') {
				return d.href
					? { key: d.key, label: d.label, href: d.href, sep: '' }
					: { key: d.key, label: d.label, text: d.value, sep: '' };
			}
			return { key: d.key, label: d.label, tokens: [d.value], filter: d.filter, sep: ', ' };
		})
	);
</script>

{#snippet linkList(links: RenderedLink[])}
	<ul class="flex flex-col gap-1">
		{#each links as l (l.site)}
			<li>
				<a
					href={l.href}
					target="_blank"
					rel="nofollow noopener noreferrer ugc"
					class="inline-flex items-center gap-1.5 break-all hover:underline"
					><SiteIcon icon={l.icon} /><span class="sr-only">{l.label}:</span>
					{l.handle}</a
				>
			</li>
		{/each}
	</ul>
{/snippet}

<svelte:head>
	<title>{p.name ?? 'Member'} — {data.group.name}</title>
</svelte:head>

<section class="space-y-4">
	<Breadcrumbs
		items={[{ label: 'Directory', href: `${base}/members` }, { label: p.name ?? 'Member' }]}
	/>

	<div
		class="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-neutral-900"
	>
		<div
			class="flex flex-col gap-3 px-6 py-5 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
		>
			<div class="flex min-w-0 items-center gap-4">
				<!-- Slightly smaller avatar on mobile to free up header width. -->
				<span class="sm:hidden">
					<Gravatar name={p.name} size={52} avatarId={p.avatarId} />
				</span>
				<span class="hidden sm:block">
					<Gravatar name={p.name} size={64} avatarId={p.avatarId} />
				</span>
				<div class="min-w-0">
					<h1 class="text-2xl font-bold">{p.name ?? 'Unnamed member'}</h1>
					{#if p.email || p.handle}
						<!-- flex-wrap so a long email + handle wrap to a second line instead of
						     overflowing (the card clips overflow with rounded corners). -->
						<p
							class="flex flex-wrap items-center gap-x-1.5 text-sm text-gray-500 dark:text-neutral-400"
						>
							{#if p.email}
								<a
									href={`mailto:${p.email}`}
									class="min-w-0 break-all transition hover:text-gray-700 hover:underline dark:hover:text-neutral-300"
									>{p.email}</a
								>
							{/if}
							{#if p.email && p.handle}<span
									class="text-gray-400 dark:text-neutral-500"
									aria-hidden="true">·</span
								>{/if}
							{#if p.handle}
								<a
									href={searchHref(p.handle)}
									class="min-w-0 break-all transition hover:text-gray-700 hover:underline dark:hover:text-neutral-300"
									>{p.handle}</a
								>
							{/if}
						</p>
					{/if}
				</div>
			</div>
			{#if data.starred !== undefined || data.canEdit}
				<div class="flex shrink-0 items-center gap-2 self-start sm:self-auto">
					{#if data.starred !== undefined}
						<StarButton {base} memberId={p.ref} starred={data.starred} />
					{/if}
					{#if data.canEdit}
						<a
							href={`${base}/members/${p.ref}/edit`}
							class="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-white/5"
						>
							Edit
						</a>
					{/if}
				</div>
			{/if}
		</div>

		{#if p.bio}
			<div class="border-t border-gray-100 px-6 py-5 dark:border-white/10">
				<p class="whitespace-pre-line text-gray-700 dark:text-neutral-300">
					{#each bioSegments as s, i (i)}{#if s.kind === 'link'}<a
								href={s.href}
								target="_blank"
								rel="nofollow noopener noreferrer ugc"
								class="break-all text-link hover:underline">{s.text}</a
							>{:else}{s.text}{/if}{/each}
				</p>
			</div>
		{/if}

		{#if details.length}
			<dl
				class="divide-y divide-gray-100 border-t border-gray-100 dark:divide-white/10 dark:border-white/10"
			>
				{#each details as d (d.key)}
					<div class="grid grid-cols-1 gap-1 px-6 py-4 sm:grid-cols-3 sm:gap-4">
						<dt class="font-medium text-gray-900 dark:text-neutral-100">{d.label}</dt>
						<dd class="text-gray-700 dark:text-neutral-300 sm:col-span-2">
							{#if d.links}
								{@render linkList(d.links)}
							{:else if d.href}
								<a
									href={d.href}
									target="_blank"
									rel="noopener noreferrer"
									class="break-all text-link hover:underline"
								>
									{urlDisplay(d.href)}
								</a>
							{:else if d.text !== undefined}
								<span class="break-all">{d.text}</span>
							{:else if d.entries}
								<div class="space-y-1">
									{#each d.entries as e, i (e.main + i)}
										<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
											{#if e.main}<a href={searchHref(e.main)} class="hover:underline">{e.main}</a
												>{/if}
											{#each e.pills as pill (pill)}
												<a
													href={searchHref(pill)}
													class="rounded-full border border-gray-300 bg-gray-50 px-2 py-0.5 text-xs text-gray-700 transition hover:bg-gray-100 dark:border-white/15 dark:bg-white/5 dark:text-neutral-300 dark:hover:bg-white/10"
													>{pill}</a
												>
											{/each}
										</div>
									{/each}
								</div>
							{:else}
								{#each d.tokens ?? [] as t, i (t + i)}{#if i > 0}{d.sep}{/if}<a
										href={d.filter ? filterHref(d.filter) : searchHref(t)}
										class="hover:underline">{t}</a
									>{/each}
							{/if}
						</dd>
					</div>
				{/each}
			</dl>
		{/if}
	</div>

	{#if data.privateFields}
		<!-- Collapsed by default; extra top margin (!mt-8 beats the section's space-y-4)
		     to separate it from the public card. -->
		<details
			class="group !mt-8 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-neutral-900"
		>
			<summary
				class="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 [&::-webkit-details-marker]:hidden"
			>
				<div>
					<h2 class="text-xl font-bold">Private</h2>
					<p class="text-sm text-gray-500 dark:text-neutral-400">
						All fields below are private and only visible to admins, and will be used only if
						absolutely necessary.
					</p>
				</div>
				<svg
					viewBox="0 0 20 20"
					fill="currentColor"
					class="size-5 shrink-0 text-gray-400 transition-transform group-open:rotate-180 dark:text-neutral-500"
					aria-hidden="true"
				>
					<path
						fill-rule="evenodd"
						d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z"
						clip-rule="evenodd"
					/>
				</svg>
			</summary>
			<dl
				class="divide-y divide-gray-100 border-t border-gray-100 dark:divide-white/10 dark:border-white/10"
			>
				{#each data.privateFields as f (f.key)}
					<div class="grid grid-cols-1 gap-1 px-6 py-4 sm:grid-cols-3 sm:gap-4">
						<dt class="font-medium text-gray-900 dark:text-neutral-100">{f.label}</dt>
						<dd class="text-gray-700 dark:text-neutral-300 sm:col-span-2">
							{#if f.links?.length}{@render linkList(f.links)}{:else}{f.value ?? '—'}{/if}
						</dd>
					</div>
				{/each}
			</dl>
		</details>
	{/if}
</section>
