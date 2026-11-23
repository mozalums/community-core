<!-- A links field: one row per saved link, each a site picker, a value box and
     a remove control, and [+] for another row. Every row posts `<name>:site`
     and `<name>:handle`, in order; `<name>:links` posts always, so a form that
     removed every row still says so. The server renders native selects and
     one blank row, which save without JavaScript; the picker with icons
     replaces them once the component mounts. -->
<script lang="ts">
	import { onMount, tick, untrack } from 'svelte';
	import SiteIcon from './SiteIcon.svelte';
	import { pickerInit, pickerKey, sitesForRow } from './site-picker';
	import { expectedForm, reduceLink, type LinkEntry, type SiteDef } from '../links';

	const {
		name,
		label,
		sites,
		entries,
		required = false,
		error = ''
	}: {
		name: string;
		label: string;
		sites: SiteDef[];
		entries: LinkEntry[];
		// At least one link, as `required` means for the other controls.
		required?: boolean;
		error?: string;
	} = $props();

	type Row = { key: number; site: string; handle: string };
	let next = 0;
	// The rows start from the saved entries and are the member's from then on;
	// the page remounts the field when a save answers.
	let rows = $state<Row[]>(
		untrack(() =>
			entries
				.filter((e) => sites.some((s) => s.id === e.site))
				.map((e) => ({ key: next++, site: e.site, handle: e.handle }))
		)
	);
	let mounted = $state(false);
	onMount(() => (mounted = true));

	// One picker is open at a time.
	let openRow = $state(-1);
	let picker = $state(pickerInit());

	const chosen = $derived(rows.map((r) => r.site));
	const optionsFor = (i: number) => sitesForRow(sites, chosen, i);
	const siteOf = (id: string) => sites.find((s) => s.id === id);
	const available = $derived(sitesForRow(sites, chosen, -1));
	const boxId = (i: number) => `f-${name}-site-${i}`;
	const listId = (i: number) => `f-${name}-sites-${i}`;
	const optId = (i: number, j: number) => `f-${name}-site-${i}-opt-${j}`;
	const errorId = $derived(`f-${name}-error`);

	function pick(i: number, j: number) {
		const o = optionsFor(i)[j];
		if (o) rows[i].site = o.id;
		openRow = -1;
		picker = pickerInit();
	}

	const labelsFor = (i: number) => optionsFor(i).map((o) => o.label);
	const currentOf = (i: number) => optionsFor(i).findIndex((o) => o.id === rows[i].site);

	function onkeydown(i: number, e: KeyboardEvent) {
		const s = openRow === i ? picker : pickerInit();
		const r = pickerKey(s, e.key, labelsFor(i), currentOf(i));
		if (!r) return;
		if (e.key !== 'Tab') e.preventDefault();
		if (r.pick !== undefined) pick(i, r.pick);
		else {
			picker = r.state;
			openRow = r.state.open ? i : -1;
		}
	}

	function toggle(i: number) {
		if (openRow === i) {
			openRow = -1;
			picker = pickerInit();
			return;
		}
		const r = pickerKey(pickerInit(), 'Enter', labelsFor(i), currentOf(i));
		if (!r) return;
		picker = r.state;
		openRow = i;
	}

	// A pasted profile address becomes its handle as the box is left. The
	// server repeats this and its answer is the one that counts.
	function reduce(i: number) {
		const site = siteOf(rows[i].site);
		if (!site || !rows[i].handle.trim()) return;
		const c = reduceLink(site, rows[i].handle);
		if (c.ok) rows[i].handle = c.handle;
	}

	async function add() {
		rows.push({ key: next++, site: '', handle: '' });
		const i = rows.length - 1;
		await tick();
		document.getElementById(boxId(i))?.focus();
		toggle(i);
	}

	async function remove(i: number) {
		rows.splice(i, 1);
		openRow = -1;
		await tick();
		const target = rows.length ? boxId(Math.min(i, rows.length - 1)) : `f-${name}`;
		document.getElementById(target)?.focus();
	}
</script>

<div
	role="group"
	aria-label={label}
	aria-describedby={error ? errorId : undefined}
	class="space-y-2"
	data-links={name}
>
	<input type="hidden" name={`${name}:links`} value="" />
	{#each rows as row, i (row.key)}
		{@const site = siteOf(row.site)}
		<div class="flex items-center gap-2" data-row={i}>
			{#if mounted}
				<div class="relative w-40 shrink-0">
					<div
						id={boxId(i)}
						role="combobox"
						tabindex="0"
						aria-label="Site"
						aria-haspopup="listbox"
						aria-expanded={openRow === i}
						aria-controls={listId(i)}
						aria-activedescendant={openRow === i && picker.active >= 0
							? optId(i, picker.active)
							: undefined}
						onkeydown={(e) => onkeydown(i, e)}
						onclick={() => toggle(i)}
						onblur={() => {
							if (openRow === i) openRow = -1;
						}}
						class="flex w-full cursor-pointer items-center gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm text-black dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
					>
						{#if site}<SiteIcon icon={site.icon} /><span>{site.label}</span>{:else}<span
								class="text-gray-400 dark:text-neutral-500">Choose a site</span
							>{/if}
					</div>
					{#if openRow === i}
						<ul
							id={listId(i)}
							role="listbox"
							aria-label="Sites"
							class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border border-gray-200 bg-white py-1 text-sm shadow-lg dark:border-white/10 dark:bg-neutral-800"
						>
							{#each optionsFor(i) as o, j (o.id)}
								<li
									id={optId(i, j)}
									role="option"
									aria-selected={picker.active === j}
									onmousedown={(e) => {
										e.preventDefault();
										pick(i, j);
									}}
									class="flex cursor-pointer items-center gap-2 px-3 py-1.5 {picker.active === j
										? 'bg-gray-100 dark:bg-white/10'
										: ''}"
								>
									<SiteIcon icon={o.icon} /><span>{o.label}</span>
								</li>
							{/each}
						</ul>
					{/if}
					<input type="hidden" name={`${name}:site`} value={row.site} />
				</div>
			{:else}
				<select
					name={`${name}:site`}
					aria-label="Site"
					class="w-40 shrink-0 rounded-md border-gray-300 bg-white text-sm text-black dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
				>
					{#each optionsFor(i) as o (o.id)}
						<option value={o.id} selected={o.id === row.site}>{o.label}</option>
					{/each}
				</select>
			{/if}
			<input
				name={`${name}:handle`}
				aria-label={site ? `${site.label} handle` : 'Handle'}
				placeholder={site ? expectedForm(site) : ''}
				bind:value={row.handle}
				onblur={() => reduce(i)}
				aria-invalid={error ? 'true' : undefined}
				class="min-w-0 flex-1 rounded-md border-gray-300 bg-white text-sm text-black placeholder:text-gray-400 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500"
			/>
			{#if mounted}
				<button
					type="button"
					aria-label={`Remove ${site?.label ?? 'this'} link`}
					onclick={() => remove(i)}
					class="rounded-md border border-gray-300 px-2.5 py-1.5 text-sm text-gray-600 transition hover:bg-gray-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-white/5"
					>×</button
				>
			{/if}
		</div>
	{/each}
	{#if !mounted && available.length}
		<!-- Without JavaScript there is no [+]: one blank row adds a link, and
		     emptying a row's value removes it. -->
		<div class="flex items-center gap-2" data-row="new">
			<select
				id={`f-${name}`}
				name={`${name}:site`}
				aria-label="Site"
				class="w-40 shrink-0 rounded-md border-gray-300 bg-white text-sm text-black dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
			>
				<option value="">—</option>
				{#each available as o (o.id)}<option value={o.id}>{o.label}</option>{/each}
			</select>
			<input
				name={`${name}:handle`}
				aria-label="Handle"
				required={required && rows.length === 0}
				class="min-w-0 flex-1 rounded-md border-gray-300 bg-white text-sm text-black dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
			/>
		</div>
	{/if}
	{#if mounted && available.length}
		<button
			type="button"
			id={`f-${name}`}
			aria-label={`Add a ${label} row`}
			onclick={add}
			class="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-white/5"
			>+</button
		>
	{/if}
	{#if required && mounted}
		<!-- The rows are not one input, so the browser's required check needs
		     one that is empty exactly when no row holds a link. -->
		<input
			class="sr-only"
			tabindex="-1"
			aria-hidden="true"
			required
			value={rows.some((r) => r.site && r.handle.trim()) ? 'set' : ''}
		/>
	{/if}
	{#if error}
		<p id={errorId} class="text-sm text-red-600 dark:text-red-400">{error}</p>
	{/if}
</div>
