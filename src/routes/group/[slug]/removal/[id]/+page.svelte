<script lang="ts">
	import type { ActionData } from './$types';
	const { form }: { form: ActionData } = $props();
</script>

<svelte:head>
	<title>Finish removing a profile</title>
</svelte:head>

<section
	class="mx-auto max-w-lg space-y-4 rounded-xl border border-gray-200 bg-white p-6 shadow-sm dark:border-white/10 dark:bg-neutral-900"
>
	<h1 class="text-xl font-bold">Finish removing this profile</h1>
	<p class="text-sm text-gray-600 dark:text-neutral-400">
		The profile is gone from the directory. Its photo and signed-in sessions are removed in a second
		step, and that step has not been confirmed. Running it again is safe.
	</p>
	<form method="POST">
		<button
			type="submit"
			class="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50 dark:border-red-900/40 dark:bg-neutral-900 dark:text-red-400 dark:hover:bg-red-950/30"
		>
			Finish removal
		</button>
	</form>
	{#if form?.error}
		<p class="text-sm text-red-600 dark:text-red-400">{form.error}</p>
	{/if}
</section>
