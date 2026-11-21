<script lang="ts">
	import { enhance } from '$app/forms';
	import type { PageData, ActionData } from './$types';

	const { data, form }: { data: PageData; form: ActionData } = $props();
	let submitting = $state(false);
</script>

<svelte:head>
	<title>Request to join — {data.group.name}</title>
</svelte:head>

<section class="mx-auto max-w-md space-y-6">
	{#if form?.sent}
		<div class="space-y-2 text-center">
			<h1 class="text-2xl font-bold">Check your email</h1>
			<p class="text-black/60 dark:text-neutral-400">
				We sent a link to<br /><span class="font-medium text-black dark:text-neutral-100"
					>{form.email}</span
				>. It opens the request form, which is step two below.
			</p>
		</div>
	{:else}
		<div class="space-y-1">
			<h1 class="text-2xl font-bold">Request to join {data.group.name}</h1>
			<p class="text-black/60 dark:text-neutral-400">
				{data.group.name} is members only. Joining takes three steps, and the last one is a wait.
			</p>
		</div>
	{/if}

	<!-- The order a stranger meets them. The third is the one people do not
	     expect, so it says who decides, that there is no set turnaround, and
	     that only an approval sends mail: a denied request hears nothing. -->
	<ol class="list-decimal space-y-3 pl-5 text-sm text-black/80 dark:text-neutral-300">
		<li>
			<span class="font-medium">Confirm your email.</span> Enter your address below and we email you a
			one-time link.
		</li>
		<li>
			<span class="font-medium">Tell us who you are.</span> The link opens a short form about you.
		</li>
		<li id="join-review">
			<span class="font-medium">Wait for an admin.</span> One of the community's admins reviews each request
			by hand. There is no set turnaround, so it can take days. We email you when you are approved, and
			that email is the only one you will get.
		</li>
	</ol>

	{#if !form?.sent}
		{#if form?.error}
			<p class="text-sm text-rose-600 dark:text-rose-400">{form.error}</p>
		{/if}

		<form
			method="POST"
			action="?/send"
			class="space-y-3"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
		>
			<div class="space-y-1">
				<label for="join-email" class="block text-sm font-medium">Email address</label>
				<input
					id="join-email"
					type="email"
					name="email"
					required
					autocomplete="email"
					placeholder="you@example.com"
					value={form?.email ?? ''}
					class="w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-black placeholder-gray-400 focus:border-black focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder-neutral-500 dark:focus:border-white"
				/>
			</div>
			<button
				type="submit"
				disabled={submitting}
				class="w-full rounded-full bg-accent px-6 py-2.5 text-sm font-medium text-accent-contrast transition hover:opacity-80 disabled:opacity-60"
			>
				{submitting ? 'Sending…' : 'Email me the link'}
			</button>
		</form>
	{/if}
</section>
