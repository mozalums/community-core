<script lang="ts">
	import { brand, site } from '$skin/skin.yaml';
	import { enhance } from '$app/forms';
	import PasskeySignIn from '$lib/components/PasskeySignIn.svelte';
	import type { PageData, ActionData } from './$types';

	const { data, form }: { data: PageData; form: ActionData } = $props();
	let submitting = $state(false);
</script>

<svelte:head>
	<title>Sign in — {site.name}</title>
</svelte:head>

<main
	class="flex min-h-screen flex-col items-center justify-center bg-stone-100 px-6 py-12 text-black dark:bg-neutral-950 dark:text-neutral-100"
>
	<div class="w-full max-w-sm space-y-6 text-center">
		<a href={data.home} class="inline-block">
			<img src="/{brand.wordmark}" alt={site.name} class="mx-auto h-10 w-auto dark:invert" />
		</a>

		{#if form?.sent}
			<div class="space-y-2">
				<h1 class="text-2xl font-bold">Check your email</h1>
				<p class="text-black/60 dark:text-neutral-400">
					We sent a sign-in link to<br /><span class="font-medium text-black dark:text-neutral-100"
						>{form.email}</span
					>
				</p>
			</div>
			<a
				href="/login"
				class="inline-block text-sm text-gray-500 underline underline-offset-2 hover:text-gray-700 dark:text-neutral-400 dark:hover:text-neutral-300"
			>
				Use a different email
			</a>
		{:else}
			<div class="space-y-1">
				<h1 class="text-2xl font-bold">Sign in to {site.name}</h1>
				<p class="text-black/60 dark:text-neutral-400">
					Enter your email and we'll send you a sign-in link.
				</p>
			</div>

			{#if form?.error}
				<p class="text-sm text-rose-600 dark:text-rose-400">{form.error}</p>
			{:else if data.error}
				<p class="text-sm text-rose-600 dark:text-rose-400">{data.error}</p>
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
				<input type="hidden" name="callbackUrl" value={data.callbackUrl} />
				<div class="space-y-1 text-left">
					<label for="login-email" class="block text-sm font-medium">Email address</label>
					<input
						id="login-email"
						type="email"
						name="email"
						required
						autocomplete={data.passkeys ? 'username webauthn' : 'email'}
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
					{submitting ? 'Sending…' : 'Send me a sign-in link'}
				</button>
			</form>

			{#if data.passkeys}
				<PasskeySignIn callbackUrl={data.callbackUrl} />
			{/if}

			<p class="text-sm text-black/60 dark:text-neutral-400">
				Not a member yet? Signing in does not make you one.
				<a href={data.joinHref} class="underline underline-offset-2 hover:no-underline"
					>Request to join</a
				>
			</p>
		{/if}
	</div>
</main>
