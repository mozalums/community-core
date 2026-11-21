<script lang="ts">
	import type { PageData } from './$types';
	const { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Privacy — {data.group.name}</title>
</svelte:head>

<!-- Safe: renderMarkdown escapes raw HTML, so only markdown-it output is emitted. -->
<article class="prose prose-neutral mx-auto max-w-2xl dark:prose-invert">
	{@html data.html}
</article>
