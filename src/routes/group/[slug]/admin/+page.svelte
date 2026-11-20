<script lang="ts">
	import { page } from '$app/stores';
	import { groupBase } from '$lib/group-nav';
	import type { PageData } from './$types';

	const { data }: { data: PageData } = $props();
	const exportHref = $derived(`${groupBase($page.url.pathname, data.group.slug)}/admin/export`);
</script>

<section class="space-y-6">
	<h1 class="text-2xl font-bold tracking-tight">Overview</h1>

	<!-- Metric -->
	<div
		class="inline-flex flex-col rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm dark:border-white/10 dark:bg-neutral-900"
	>
		<span class="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-neutral-400"
			>Active members</span
		>
		<span class="mt-1 text-3xl font-semibold tabular-nums text-gray-900 dark:text-neutral-100"
			>{data.memberCount}</span
		>
	</div>

	<!-- Roster export -->
	<div
		class="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-neutral-900"
	>
		<div class="px-5 py-4">
			<h2 class="text-sm font-semibold text-gray-900 dark:text-neutral-100">Export the roster</h2>
			<p class="mt-0.5 text-sm text-gray-500 dark:text-neutral-400">
				A CSV with the profile fields as columns, for Excel or Sheets. A cell that starts with an
				apostrophe was written that way on purpose, so a spreadsheet cannot run it as a formula.
			</p>
			<ul class="mt-3 space-y-1 text-sm">
				<li>
					<a
						class="font-medium text-blue-700 hover:underline dark:text-blue-400"
						href={exportHref}
						download>Active members</a
					>
					<span class="text-gray-500 dark:text-neutral-400">· the fields members can see</span>
				</li>
				<li>
					<a
						class="font-medium text-blue-700 hover:underline dark:text-blue-400"
						href={`${exportHref}?private=1`}
						download>With private fields</a
					>
					<span class="text-gray-500 dark:text-neutral-400"
						>· adds addresses, phone numbers and sizes; recorded in the audit trail</span
					>
				</li>
				<li>
					<a
						class="font-medium text-blue-700 hover:underline dark:text-blue-400"
						href={`${exportHref}?private=1&removed=1`}
						download>Full export, removed members included</a
					>
				</li>
			</ul>
		</div>
	</div>
</section>
