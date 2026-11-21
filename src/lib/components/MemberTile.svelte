<script lang="ts">
	import Gravatar from '$lib/components/Gravatar.svelte';
	import StarButton from '$lib/components/StarButton.svelte';

	type DirectoryMember = {
		id: string;
		// The profile URL segment (username or uuid); the star endpoint is under it.
		ref?: string;
		name: string | null;
		city: string | null;
		avatarId: string | null;
		matched: { label: string; words: string[] }[];
	};

	type Props = {
		member: DirectoryMember;
		href: string;
		base: string;
		starred: boolean;
	};
	const { member: m, href, base, starred }: Props = $props();

	const name = $derived(m.name ?? 'Unnamed member');
	// Everything before the last word is held to one line, so the last word
	// always starts inside the two-line clamp. Clamping the whole string lets a
	// long given name fill both lines and hide the surname entirely.
	const words = $derived(name.trim().split(/\s+/));
	const given = $derived(words.slice(0, -1).join(' '));
	const surname = $derived(words.at(-1));
	const matched = $derived(m.matched.map((x) => `${x.label}: ${x.words.join(', ')}`).join(' · '));
	// The name can be clamped and the city and match line truncated, so the link
	// is named from the full strings rather than from whatever text survived.
	const label = $derived([name, m.city, matched].filter(Boolean).join(', '));
</script>

<li
	class="relative rounded-lg border border-gray-200 bg-white transition hover:border-gray-300 hover:shadow-sm dark:border-white/10 dark:bg-neutral-900 dark:hover:border-white/20"
>
	<a {href} aria-label={label} class="flex items-center gap-3 p-3">
		<Gravatar name={m.name} size={40} avatarId={m.avatarId} />
		<div class="min-w-0 flex-1">
			<!-- Hyphenation follows <html lang>. -->
			<p
				title={name}
				class="line-clamp-2 hyphens-auto break-words font-medium text-black dark:text-neutral-100"
			>
				{#if given}<span data-given-names class="inline-block max-w-full truncate align-top"
						>{given}</span
					>{' '}{/if}{surname}
			</p>
			{#if m.city}
				<p class="truncate text-sm text-gray-500 dark:text-neutral-400">{m.city}</p>
			{/if}
			{#if matched}
				<p class="truncate text-xs text-gray-500 dark:text-neutral-400">{matched}</p>
			{/if}
		</div>
		<!-- Reserves the star's column for the full height of the text, so a
		     wrapped name stays clear of the absolutely positioned corner star. -->
		<span data-star-gutter class="w-5 shrink-0"></span>
	</a>
	<StarButton {base} memberId={m.ref ?? m.id} {starred} class="absolute bottom-2.5 right-2.5" />
</li>
