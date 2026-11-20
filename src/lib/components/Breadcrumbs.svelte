<script lang="ts">
	// Breadcrumb trail. Pass the path as items in order; the last item is the
	// current page (rendered as plain, non-linked text). Items before it should
	// have an `href`.
	type Crumb = { label: string; href?: string };
	const { items }: { items: Crumb[] } = $props();
</script>

<nav aria-label="Breadcrumb" class="text-sm">
	<ol class="flex flex-wrap items-center gap-1.5 text-gray-500 dark:text-neutral-400">
		{#each items as item, i (item.label + i)}
			<li class="flex items-center gap-1.5">
				{#if item.href && i < items.length - 1}
					<a
						href={item.href}
						class="transition hover:text-gray-700 hover:underline dark:hover:text-neutral-300"
						>{item.label}</a
					>
				{:else}
					<span class="font-medium text-gray-700 dark:text-neutral-300" aria-current="page"
						>{item.label}</span
					>
				{/if}
				{#if i < items.length - 1}
					<span class="text-gray-300 dark:text-neutral-500" aria-hidden="true">/</span>
				{/if}
			</li>
		{/each}
	</ol>
</nav>
