<script lang="ts">
	import { onMount } from 'svelte';
	import { startRegistration, WebAuthnError } from '@simplewebauthn/browser';
	import type { PasskeySummary } from '$lib/server/passkeys';

	const {
		passkeys,
		endpoint,
		returnTo
	}: {
		passkeys: { fresh: boolean; email: string };
		endpoint: string;
		returnTo: string;
	} = $props();

	// Fetched rather than loaded with the page, so the page's server module
	// never reaches the credential store.
	let list = $state<PasskeySummary[] | null>(null);
	let nickname = $state('');
	let busy = $state(false);
	let error = $state('');
	let linkSent = $state(false);

	const day = (iso: string | null) => (iso ? iso.slice(0, 10) : 'Never');

	async function send(method: string, body?: unknown): Promise<Response> {
		return fetch(endpoint, {
			method,
			headers: { 'content-type': 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body)
		});
	}
	const post = (body: unknown) => send('POST', body);

	async function refresh() {
		const res = await send('GET');
		if (res.ok) list = await res.json();
		else error = 'Your passkeys could not be loaded. Reload the page.';
	}
	onMount(refresh);

	async function remove(p: PasskeySummary) {
		if (!confirm(`Remove the passkey "${p.nickname}"? You can still sign in with an email link.`)) {
			return;
		}
		error = '';
		const res = await send('DELETE', { id: p.id });
		if (!res.ok && res.status !== 404) error = 'The passkey was not removed. Try again.';
		await refresh();
	}

	async function add() {
		error = '';
		if (!nickname.trim()) {
			error = 'Give the passkey a name you will recognize, like "Work laptop".';
			return;
		}
		busy = true;
		try {
			const res = await post({ step: 'options' });
			if (!res.ok) {
				error = 'This sign-in is too old to add a passkey. Reload the page.';
				return;
			}
			const response = await startRegistration({ optionsJSON: await res.json() });
			const done = await post({ step: 'verify', response, nickname });
			if (!done.ok) {
				const { error: reason } = await done.json().catch(() => ({ error: '' }));
				error =
					reason === 'duplicate'
						? 'That passkey is already registered.'
						: 'The passkey was not accepted. Try again.';
				return;
			}
			nickname = '';
			await refresh();
		} catch (e) {
			error =
				e instanceof WebAuthnError && e.code === 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'
					? 'That passkey is already registered.'
					: 'No passkey was created.';
		} finally {
			busy = false;
		}
	}

	async function sendLink() {
		busy = true;
		try {
			await fetch('/auth/magic/send', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email: passkeys.email, callbackUrl: returnTo })
			});
			linkSent = true;
		} finally {
			busy = false;
		}
	}
</script>

<div
	id="passkeys"
	class="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-neutral-900"
>
	<div class="border-b border-gray-200 px-6 py-5 dark:border-white/10">
		<h2 class="text-xl font-bold">Passkeys</h2>
		<p class="text-sm text-gray-500 dark:text-neutral-400">
			Sign in with your device instead of waiting for an email. The email link keeps working whether
			you have a passkey or not.
		</p>
	</div>

	{#if list?.length}
		<table class="w-full text-left text-sm">
			<thead class="text-gray-500 dark:text-neutral-400">
				<tr>
					<th class="px-6 py-2 font-medium">Name</th>
					<th class="px-2 py-2 font-medium">Created</th>
					<th class="px-2 py-2 font-medium">Last used</th>
					<th class="px-6 py-2"><span class="sr-only">Remove</span></th>
				</tr>
			</thead>
			<tbody class="divide-y divide-gray-200 dark:divide-white/10">
				{#each list as p (p.id)}
					<tr>
						<td class="px-6 py-2">{p.nickname}</td>
						<td class="px-2 py-2">{day(p.createdAt)}</td>
						<td class="px-2 py-2">{day(p.lastUsedAt)}</td>
						<td class="px-6 py-2 text-right">
							<button
								type="button"
								onclick={() => remove(p)}
								class="text-sm text-red-600 underline underline-offset-2 hover:no-underline dark:text-red-400"
								aria-label={`Remove passkey ${p.nickname}`}>Remove</button
							>
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}

	<div class="space-y-2 px-6 py-5">
		{#if passkeys.fresh}
			<label for="passkey-nickname" class="block text-sm font-medium">Name for a new passkey</label>
			<div class="flex gap-2">
				<input
					id="passkey-nickname"
					type="text"
					maxlength="64"
					bind:value={nickname}
					placeholder="e.g. Work laptop"
					class="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-neutral-600 dark:bg-neutral-800"
				/>
				<button
					type="button"
					onclick={add}
					disabled={busy}
					class="shrink-0 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
				>
					Add a passkey
				</button>
			</div>
		{:else if linkSent}
			<p class="text-sm">
				We sent a sign-in link to {passkeys.email}. Open it, and you'll come back here able to add a
				passkey.
			</p>
		{:else}
			<p class="text-sm text-gray-500 dark:text-neutral-400">
				Adding a passkey needs a sign-in from the last ten minutes.
			</p>
			<button
				type="button"
				onclick={sendLink}
				disabled={busy}
				class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium transition hover:bg-gray-50 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
			>
				Email me a fresh sign-in link
			</button>
		{/if}
		{#if list && !list.length}
			<p class="text-sm text-gray-500 dark:text-neutral-400">You have no passkeys yet.</p>
		{/if}
		{#if error}
			<p class="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
		{/if}
	</div>
</div>
