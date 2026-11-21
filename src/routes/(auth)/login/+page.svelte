<script lang="ts">
	import { brand, site } from '$skin/skin.yaml';
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import {
		browserSupportsWebAuthn,
		browserSupportsWebAuthnAutofill,
		startAuthentication
	} from '@simplewebauthn/browser';
	import type { PageData, ActionData } from './$types';

	const { data, form }: { data: PageData; form: ActionData } = $props();
	let submitting = $state(false);
	let passkeyError = $state('');
	let passkeyBusy = $state(false);
	// Rendered on the server, hidden after mount where the browser has no WebAuthn.
	let canPasskey = $state(true);

	async function passkeyOptions() {
		const res = await fetch('/auth/passkey', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ step: 'options' })
		});
		if (!res.ok) throw new Error('options');
		return res.json();
	}

	async function finishPasskey(response: unknown) {
		const res = await fetch('/auth/passkey', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ step: 'verify', response, callbackUrl: data.callbackUrl })
		});
		if (!res.ok) {
			passkeyError =
				res.status === 429
					? 'Too many sign-in attempts. Wait a few minutes and try again.'
					: 'That passkey was not accepted. Use the email link instead.';
			return;
		}
		const { redirect } = await res.json();
		window.location.assign(redirect);
	}

	async function signInWithPasskey() {
		passkeyError = '';
		passkeyBusy = true;
		try {
			const response = await startAuthentication({ optionsJSON: await passkeyOptions() });
			await finishPasskey(response);
		} catch {
			passkeyError = 'No passkey was used. You can sign in with the email link instead.';
		} finally {
			passkeyBusy = false;
		}
	}

	// Conditional mediation: the browser lists this site's passkeys in the email
	// field's autofill, and picking one signs in with no button pressed. The
	// ceremony stays pending until then, and the button above aborts it.
	onMount(() => {
		if (!data.passkeys) return;
		canPasskey = browserSupportsWebAuthn();
		void (async () => {
			if (!(await browserSupportsWebAuthnAutofill())) return;
			const response = await startAuthentication({
				optionsJSON: await passkeyOptions(),
				useBrowserAutofill: true
			});
			await finishPasskey(response);
		})().catch(() => {});
	});
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

			{#if data.passkeys && canPasskey}
				<div class="space-y-2" data-passkey-signin>
					<button
						type="button"
						onclick={signInWithPasskey}
						disabled={passkeyBusy}
						class="w-full rounded-full border border-gray-300 px-6 py-2.5 text-sm font-medium transition hover:bg-white disabled:opacity-60 dark:border-neutral-600 dark:hover:bg-neutral-800"
					>
						Sign in with a passkey
					</button>
					{#if passkeyError}
						<p class="text-sm text-rose-600 dark:text-rose-400">{passkeyError}</p>
					{/if}
				</div>
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
