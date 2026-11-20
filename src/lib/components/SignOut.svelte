<script lang="ts">
	import type { Snippet } from 'svelte';

	type Props = {
		// Post-logout destination. `/logout` validates it with safeLocalPath.
		redirectTo?: string;
		// Confirmation prompt text. Omitted means sign out on the first click.
		confirm?: string;
		// Classes for the button itself — the form is layout-transparent.
		class?: string;
		title?: string;
		ariaLabel?: string;
		// Fires before submit, for callers that need to close a menu first.
		onclick?: () => void;
		// Button contents. Falls back to the plain "Sign out" label.
		children?: Snippet;
	};

	const {
		redirectTo,
		confirm: confirmText,
		class: className = '',
		title,
		ariaLabel,
		onclick,
		children
	}: Props = $props();

	const action = $derived(
		redirectTo ? `/logout?redirectTo=${encodeURIComponent(redirectTo)}` : '/logout'
	);

	function guard(e: SubmitEvent) {
		if (confirmText && !confirm(confirmText)) e.preventDefault();
	}
</script>

<!-- `display: contents` keeps the form out of the parent's flex/grid layout, so
     a sign-out control drops in where a link used to sit without moving it. -->
<form method="POST" {action} class="contents" onsubmit={guard}>
	<button type="submit" class={className} {title} aria-label={ariaLabel} {onclick}>
		{#if children}{@render children()}{:else}Sign out{/if}
	</button>
</form>
