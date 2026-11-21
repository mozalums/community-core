<!-- A filterable single-select (WAI-ARIA 1.2 combobox, list autocomplete).
     The server renders a native <select> under the same name, so the field
     posts without JavaScript; the combobox replaces it once the component
     mounts. The posted value rides a hidden input, never the text box, so a
     half-typed query cannot reach the server. -->
<script lang="ts">
	import { onMount } from 'svelte';
	import {
		comboDismiss,
		comboFiltered,
		comboInit,
		comboKey,
		comboPick,
		comboType,
		type Matcher
	} from './combobox';

	const {
		id,
		name,
		label,
		options,
		value = '',
		required = false,
		match,
		class: cls = ''
	}: {
		id: string;
		name: string;
		/** The field's name for the popup; the input takes its own from the page's <label>. */
		label: string;
		options: string[];
		value?: string;
		required?: boolean;
		match?: Matcher;
		class?: string;
	} = $props();

	let enhanced = $state(false);
	let s = $state(comboInit(''));
	let fallback = $state<HTMLSelectElement | null>(null);
	// Start from what the native select holds, in case it changed before hydration.
	onMount(() => {
		s = comboInit(fallback?.value ?? value);
		enhanced = true;
	});
	// SvelteKit reuses this component when the editor moves to another member,
	// so a new `value` from the parent replaces the committed one. Only a change
	// counts: re-running with the same value must not undo the member's pick.
	let parentValue: string | undefined;
	$effect(() => {
		if (parentValue !== undefined && value !== parentValue) s = comboInit(value);
		parentValue = value;
	});

	const listId = $derived(`${id}-list`);
	const optId = (i: number) => `${id}-opt-${i}`;
	const list = $derived(comboFiltered(options, s, match));

	function onkeydown(e: KeyboardEvent) {
		const next = comboKey(s, e.key, options, match);
		if (!next) return;
		e.preventDefault();
		s = next;
	}
	// The browser scrolls a focused element into view, but aria-activedescendant
	// leaves focus on the text box, so the list scrolls itself whenever typing,
	// opening or a key moves the active option. Effects run after the DOM update.
	$effect(() => {
		if (s.open && s.active >= 0)
			document.getElementById(optId(s.active))?.scrollIntoView({ block: 'nearest' });
	});
</script>

{#if enhanced}
	<div class="relative">
		<input type="hidden" {name} value={s.value} />
		<input
			{id}
			type="text"
			role="combobox"
			autocomplete="off"
			spellcheck="false"
			aria-autocomplete="list"
			aria-expanded={s.open}
			aria-controls={listId}
			aria-activedescendant={s.open && s.active >= 0 ? optId(s.active) : undefined}
			{required}
			value={s.text}
			oninput={(e) => (s = comboType(s, e.currentTarget.value, options, match))}
			onclick={() => (s = s.open ? s : comboKey(s, 'ArrowDown', options, match)!)}
			onblur={() => (s = comboDismiss(s))}
			{onkeydown}
			class={cls}
		/>
		<ul
			id={listId}
			role="listbox"
			aria-label={label}
			hidden={!s.open}
			class="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border border-gray-300 bg-white py-1 text-sm text-black shadow-lg dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
		>
			{#each list as o, i (o)}
				<!-- The pick is on click, which assistive technology fires without any
				     mouse-down; mousedown is cancelled only so the text box keeps focus.
				     The keyboard path is the input's keydown, so this item takes none. -->
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<li
					id={optId(i)}
					role="option"
					aria-selected={i === s.active}
					onmousedown={(e) => e.preventDefault()}
					onclick={() => (s = comboPick(s, o))}
					class="cursor-default px-3 py-1.5 {i === s.active
						? 'bg-gray-100 dark:bg-neutral-700'
						: ''}"
				>
					{o}
				</li>
			{:else}
				<li
					role="option"
					aria-selected="false"
					aria-disabled="true"
					class="px-3 py-1.5 text-gray-500"
				>
					No match
				</li>
			{/each}
		</ul>
	</div>
{:else}
	<select bind:this={fallback} {id} {name} {required} class={cls}>
		<option value="" selected={!value}>—</option>
		{#each options as o (o)}
			<option value={o} selected={o === value}>{o}</option>
		{/each}
	</select>
{/if}
