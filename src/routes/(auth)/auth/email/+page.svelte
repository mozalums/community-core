<script lang="ts">
	import { brand, site } from '$skin/skin.yaml';
	import type { ActionData, PageData } from './$types';

	const { data, form }: { data: PageData; form: ActionData } = $props();
</script>

<svelte:head>
	<title>Sign-in email — {site.name}</title>
</svelte:head>

<main
	class="flex min-h-screen flex-col items-center justify-center bg-stone-100 px-6 py-12 text-black dark:bg-neutral-950 dark:text-neutral-100"
>
	<div class="w-full max-w-sm space-y-6 text-center">
		<img src="/{brand.wordmark}" alt={site.name} class="mx-auto h-10 w-auto dark:invert" />

		{#if form && 'reverted' in form}
			<div class="space-y-2">
				<h1 class="text-2xl font-bold">Change undone</h1>
				<p class="text-black/60 dark:text-neutral-400">
					Your account signs in as this address again. Every session was signed out and the
					account's passkeys were removed.
				</p>
			</div>
			<a href="/login" class="inline-block text-sm underline underline-offset-2">Sign in</a>
		{:else if form?.error}
			<div class="space-y-2">
				<h1 class="text-2xl font-bold">Nothing changed</h1>
				<p class="text-black/60 dark:text-neutral-400" role="alert">{form.error}</p>
			</div>
		{:else if data.kind === 'change'}
			<div class="space-y-2">
				<h1 class="text-2xl font-bold">Confirm your new sign-in email</h1>
				<p class="text-black/60 dark:text-neutral-400">
					Your account will sign in as<br /><span
						class="font-medium text-black dark:text-neutral-100">{data.email}</span
					><br />and every other session will be signed out.
				</p>
			</div>
			<form method="POST" action="?/confirm">
				<input type="hidden" name="token" value={data.token} />
				<button
					type="submit"
					class="w-full rounded-full bg-accent px-6 py-2.5 text-sm font-medium text-accent-contrast transition hover:opacity-80"
				>
					Confirm this address
				</button>
			</form>
		{:else if data.kind === 'revert'}
			<div class="space-y-2">
				<h1 class="text-2xl font-bold">Undo the email change</h1>
				<p class="text-black/60 dark:text-neutral-400">
					Your account will sign in as<br /><span
						class="font-medium text-black dark:text-neutral-100">{data.email}</span
					><br />again. Every session will be signed out and the account's passkeys removed.
				</p>
			</div>
			<form method="POST" action="?/revert">
				<input type="hidden" name="token" value={data.token} />
				<button
					type="submit"
					class="w-full rounded-full bg-accent px-6 py-2.5 text-sm font-medium text-accent-contrast transition hover:opacity-80"
				>
					Undo the change
				</button>
			</form>
		{:else}
			<div class="space-y-2">
				<h1 class="text-2xl font-bold">Link expired</h1>
				<p class="text-black/60 dark:text-neutral-400">
					This link has expired or was already used.
				</p>
			</div>
			<a href="/login" class="inline-block text-sm underline underline-offset-2">Sign in</a>
		{/if}
	</div>
</main>
