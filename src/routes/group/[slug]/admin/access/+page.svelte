<script lang="ts">
	import { enhance } from '$app/forms';
	import Spinner from '$lib/components/Spinner.svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { PageData, ActionData } from './$types';

	const { data, form }: { data: PageData; form: ActionData } = $props();

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

	const isSelf = (subject: string) => subject.toLowerCase() === (data.self ?? '').toLowerCase();
	const label = (a: { subject: string; email: string | null }) =>
		a.email ?? a.subject.replace(/^email:/, '');
</script>

<svelte:head>
	<title>Admin access — {data.group.name}</title>
</svelte:head>

<section class="space-y-4">
	<div class="flex items-baseline justify-between">
		<h1 class="text-2xl font-bold">Admin access</h1>
		<span class="text-sm text-gray-500 dark:text-neutral-400">{data.admins.length} admins</span>
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

	<form
		method="POST"
		action="?/grant"
		use:enhance={track('grant')}
		class="flex flex-wrap items-end gap-2"
	>
		<label class="min-w-64 flex-1 text-sm">
			<span class="block text-gray-500 dark:text-neutral-400">Grant admin to an email address</span>
			<input
				type="email"
				name="email"
				required
				autocomplete="off"
				placeholder="name@example.com"
				class="w-full rounded-md border-gray-300 text-sm dark:border-neutral-600 dark:bg-neutral-900"
			/>
		</label>
		<button
			disabled={pending !== null}
			class="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
		>
			{#if pending === 'grant'}<Spinner />{/if}
			Grant
		</button>
	</form>
	<p class="text-sm text-gray-500 dark:text-neutral-400">
		The address does not need to have signed in yet: the grant applies the first time it does.
		Accounts listed in <code>ADMIN_SUBJECTS</code> administer every group whether or not they are
		listed here. Revoking one of them removes only this group's grant; the
		<code>ADMIN_SUBJECTS</code> entry keeps them in until it is removed from the server's environment.
	</p>

	{#if data.admins.length === 0}
		<p
			class="rounded-xl border border-gray-200 bg-white p-6 text-sm text-gray-500 dark:border-white/10 dark:bg-neutral-900 dark:text-neutral-400"
		>
			No admins granted for this group.
		</p>
	{:else}
		<ul
			class="divide-y divide-gray-200 rounded-xl border border-gray-200 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-neutral-900"
		>
			{#each data.admins as a (a.subject)}
				<li class="flex items-center justify-between gap-4 p-4">
					<div class="min-w-0">
						<p class="truncate font-medium">{label(a)}</p>
						<p class="text-xs text-gray-500 dark:text-neutral-400">
							Since {new Date(a.createdAt).toLocaleDateString()}
							{#if a.global}
								· Also in <code>ADMIN_SUBJECTS</code>: revoking here leaves their access to every
								group in place.
							{/if}
						</p>
					</div>
					{#if isSelf(a.subject)}
						<span class="max-w-xs text-right text-xs text-gray-500 dark:text-neutral-400">
							This is you. You cannot revoke your own access; another admin can, so the group is
							never left without one.
						</span>
					{:else}
						<form method="POST" action="?/revoke" use:enhance={track(`revoke:${a.subject}`)}>
							<input type="hidden" name="subject" value={a.subject} />
							<button
								disabled={pending !== null}
								class="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-white/5"
							>
								{#if pending === `revoke:${a.subject}`}<Spinner />{/if}
								Revoke
							</button>
						</form>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</section>
