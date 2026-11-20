<script lang="ts">
	import { toasts, dismissToast } from '$lib/stores/toasts';
</script>

<div
	class="pointer-events-none fixed inset-x-2 top-4 z-50 mx-auto flex max-w-md flex-col items-center gap-2"
>
	{#each $toasts as t (t.id)}
		<button
			type="button"
			class="pointer-events-auto rounded-full bg-white/10 px-4 py-2 text-sm text-white backdrop-blur-md transition hover:bg-white/20"
			onclick={() => dismissToast(t.id)}
		>
			{t.msg}
		</button>
	{/each}
</div>
