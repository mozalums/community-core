<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/stores';
	import { groupBase } from '$lib/group-nav';
	import type { PageData, ActionData } from './$types';

	const { data, form }: { data: PageData; form: ActionData } = $props();
	// Preview links to /home (not /) so the admin — who is signed in — can actually
	// see the landing; "/" would redirect them to the directory.
	const base = $derived(groupBase($page.url.pathname, data.group.slug));

	const value = $derived(form?.md ?? data.md);
	const preview = $derived(form?.preview ?? data.preview);
	let saving = $state(false);
</script>

<section class="space-y-6">
	<div class="flex items-baseline justify-between">
		<h1 class="text-2xl font-bold">Landing page</h1>
		<a
			class="text-sm text-link hover:underline"
			href={`${base}/home`}>View public page &rarr;</a
		>
	</div>

	{#if form?.error}
		<p class="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
			{form.error}
		</p>
	{:else if form?.saved}
		<p
			class="rounded-md border border-accent p-3 text-sm"
		>
			Saved. Preview below reflects the saved copy.
		</p>
	{/if}

	<div class="grid gap-6 md:grid-cols-2">
		<form
			method="POST"
			use:enhance={() => {
				saving = true;
				return async ({ update }) => {
					await update();
					saving = false;
				};
			}}
			class="space-y-3"
		>
			<label class="block text-sm text-gray-700 dark:text-neutral-300">
				Markdown
				<textarea
					name="md"
					rows="20"
					class="mt-1 w-full rounded-md border-gray-300 bg-white font-mono text-sm text-black shadow-sm focus:border-accent focus:ring-accent dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
					>{value}</textarea
				>
			</label>
			<button
				type="submit"
				disabled={saving}
				class="rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-contrast shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{saving ? 'Saving…' : 'Save'}
			</button>
		</form>

		<div>
			<p class="mb-1 text-sm text-gray-700 dark:text-neutral-300">Preview (saved copy)</p>
			<div
				class="prose max-w-none rounded-md border border-gray-200 bg-white p-4 dark:prose-invert prose-headings:text-gray-900 prose-a:text-link dark:border-white/10 dark:bg-neutral-900 dark:prose-headings:text-neutral-100"
			>
				{#if preview}
					{@html preview}
				{:else}
					<p class="text-gray-400 dark:text-neutral-500">
						Nothing yet — the default intro shows on the public page.
					</p>
				{/if}
			</div>
		</div>
	</div>
</section>
