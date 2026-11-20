<script lang="ts">
	import { enhance } from '$app/forms';
	import Spinner from '$lib/components/Spinner.svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { PageData, ActionData } from './$types';

	const { data, form }: { data: PageData; form: ActionData } = $props();

	// Which row+action is currently submitting (e.g. "approve:<request id>"), so
	// the clicked button shows a spinner and all buttons lock until it resolves.
	let pending = $state<string | null>(null);
	const track =
		(key: string): SubmitFunction =>
		() => {
			pending = key;
			return async ({ update }) => {
				await update();
				pending = null;
			};
		};

	// A detail whose value is an http(s) URL (e.g. LinkedIn) renders as a link.
	const isUrl = (v: string) => /^https?:\/\//i.test(v.trim());

	const day = new Intl.DateTimeFormat('en', { dateStyle: 'medium' });
</script>

<svelte:head>
	<title>Membership requests — {data.group.name}</title>
</svelte:head>

<section class="space-y-4">
	<div class="flex items-baseline justify-between">
		<h1 class="text-2xl font-bold">Membership requests</h1>
		<span class="text-sm text-gray-500 dark:text-neutral-400">{data.requests.length} pending</span>
	</div>

	{#if form?.error}
		<p class="rounded-md bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-300">
			{form.error}
		</p>
	{:else if form?.message}
		<p
			class="rounded-md bg-gray-50 p-3 text-sm text-gray-700 dark:bg-white/5 dark:text-neutral-300"
		>
			{form.message}
		</p>
	{/if}

	{#if data.loadError}
		<p
			class="rounded-xl border border-gray-200 bg-white p-6 text-sm text-red-600 dark:border-white/10 dark:bg-neutral-900 dark:text-red-400"
		>
			Couldn't load the pending requests: {data.loadError}
		</p>
	{:else if data.requests.length === 0}
		<p
			class="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-400"
		>
			No pending requests.
		</p>
	{:else}
		<ul class="space-y-3">
			{#each data.requests as r (r.id)}
				<li
					class="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-neutral-900"
				>
					<div class="flex items-start justify-between gap-4">
						<div class="min-w-0">
							<p class="font-medium">{r.name || r.email || 'Unnamed request'}</p>
							{#if r.email}<p class="text-sm text-gray-500 dark:text-neutral-400">{r.email}</p>{/if}
						</div>
						<div class="flex shrink-0 gap-2">
							<form method="POST" action="?/approve" use:enhance={track(`approve:${r.id}`)}>
								<input type="hidden" name="id" value={r.id} />
								<input type="hidden" name="email" value={r.email} />
								<button
									disabled={pending !== null}
									class="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
								>
									{#if pending === `approve:${r.id}`}<Spinner />{/if}
									Approve
								</button>
							</form>
							<form
								method="POST"
								action="?/deny"
								use:enhance={track(`deny:${r.id}`)}
								class="flex gap-2"
							>
								<input type="hidden" name="id" value={r.id} />
								<input type="hidden" name="email" value={r.email} />
								<input
									type="text"
									name="reason"
									maxlength="500"
									placeholder="Reason (optional)"
									aria-label="Reason for denying {r.email}"
									class="w-40 rounded-md border border-gray-300 px-2 py-1 text-sm dark:border-neutral-600 dark:bg-neutral-800"
								/>
								<button
									disabled={pending !== null}
									class="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-white/5"
								>
									{#if pending === `deny:${r.id}`}<Spinner />{/if}
									Deny
								</button>
							</form>
						</div>
					</div>

					{#if r.priorDenials.length}
						<p
							class="mt-3 rounded-md bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
						>
							Denied before:
							{#each r.priorDenials as p, i (i)}
								{i ? '; ' : ''}{p.at ? day.format(new Date(p.at)) : 'date unknown'}{p.reason
									? ` (${p.reason})`
									: ''}
							{/each}
						</p>
					{/if}

					{#if r.details.length}
						<dl class="mt-3 grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
							{#each r.details as d (d.label)}
								<div class="flex min-w-0 gap-2">
									<dt class="shrink-0 text-gray-500 dark:text-neutral-400">{d.label}:</dt>
									<dd class="min-w-0 break-words text-gray-800 dark:text-neutral-200">
										{#if isUrl(d.value)}
											<a
												href={d.value}
												target="_blank"
												rel="noopener noreferrer"
												class="text-link hover:underline">{d.value}</a
											>
										{:else}
											{d.value}
										{/if}
									</dd>
								</div>
							{/each}
						</dl>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>
