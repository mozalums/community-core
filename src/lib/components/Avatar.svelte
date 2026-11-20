<script lang="ts">
	import { avatarGradient, initialsFromSubject } from '$lib/utils/avatar';

	type Props = {
		subject: string | null | undefined;
		size?: number;
		showInitials?: boolean;
	};

	const { subject, size = 32, showInitials = false }: Props = $props();
	const gradient = $derived(avatarGradient(subject));
	const initials = $derived(initialsFromSubject(subject));
</script>

<span
	class="inline-flex items-center justify-center rounded-full font-medium text-white shadow-inner"
	style="width: {size}px; height: {size}px; background: {gradient}; font-size: {Math.round(
		size * 0.4
	)}px;"
	aria-hidden="true"
>
	{#if showInitials}{initials}{/if}
</span>
