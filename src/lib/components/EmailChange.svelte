<script lang="ts">
	import { startAuthentication } from '@simplewebauthn/browser';

	const {
		emailChange,
		endpoint,
		returnTo
	}: {
		emailChange: { reauth: 'ok' | 'stale' | 'passkey'; email: string };
		endpoint: string;
		returnTo: string;
	} = $props();

	let next = $state('');
	let busy = $state(false);
	let error = $state('');
	let sentTo = $state('');
	let linkSent = $state(false);

	const REASONS: Record<string, string> = {
		invalid: 'Enter a valid email address.',
		same: 'That is already your sign-in email.',
		stale: 'This sign-in is too old to change your email. Sign in again below.',
		passkey: 'Your account has a passkey. Confirm with it below to change your email.'
	};

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		error = '';
		busy = true;
		try {
			const res = await fetch(endpoint, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email: next, returnTo })
			});
			if (res.ok) {
				sentTo = next.trim();
				next = '';
				return;
			}
			const { error: reason } = await res.json().catch(() => ({ error: '' }));
			error = REASONS[reason] ?? 'The request did not go through. Try again.';
		} finally {
			busy = false;
		}
	}

	// A passkey sign-in mints a fresh session and comes straight back here.
	async function withPasskey() {
		error = '';
		busy = true;
		try {
			const post = (body: unknown) =>
				fetch('/auth/passkey', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(body)
				});
			const opts = await post({ step: 'options' });
			if (!opts.ok) throw new Error('options');
			const response = await startAuthentication({ optionsJSON: await opts.json() });
			const done = await post({ step: 'verify', response, callbackUrl: returnTo });
			if (!done.ok) throw new Error('verify');
			location.assign((await done.json()).redirect);
		} catch {
			error = 'The passkey did not sign you in. Try again.';
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
				body: JSON.stringify({ email: emailChange.email, callbackUrl: returnTo })
			});
			linkSent = true;
		} finally {
			busy = false;
		}
	}
</script>

<div
	id="sign-in-email"
	class="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-neutral-900"
>
	<div class="border-b border-gray-200 px-6 py-5 dark:border-white/10">
		<h2 class="text-xl font-bold">Sign-in email</h2>
		<p class="text-sm text-gray-500 dark:text-neutral-400">
			You sign in as <span class="font-medium">{emailChange.email}</span>. A change applies once you
			confirm it from the new address, and the old one is told and can undo it for 7 days.
		</p>
	</div>

	<div class="space-y-2 px-6 py-5">
		{#if sentTo}
			<p class="text-sm" role="status">
				If {sentTo} can be used, a confirmation link is on its way there. It works for 30 minutes.
			</p>
		{:else if emailChange.reauth === 'ok'}
			<form class="space-y-2" onsubmit={submit}>
				<label for="new-sign-in-email" class="block text-sm font-medium">New sign-in email</label>
				<div class="flex gap-2">
					<input
						id="new-sign-in-email"
						type="email"
						required
						autocomplete="email"
						bind:value={next}
						class="w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm dark:border-neutral-600 dark:bg-neutral-800"
					/>
					<button
						type="submit"
						disabled={busy}
						class="shrink-0 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
					>
						Send confirmation
					</button>
				</div>
			</form>
		{:else if linkSent}
			<p class="text-sm">
				We sent a sign-in link to {emailChange.email}. Open it, and you'll come back here able to
				change your email.
			</p>
		{:else if emailChange.reauth === 'passkey'}
			<p class="text-sm text-gray-500 dark:text-neutral-400">
				Your account has a passkey, so changing your sign-in email needs a passkey sign-in from the
				last ten minutes. An email link is not enough.
			</p>
			<button
				type="button"
				onclick={withPasskey}
				disabled={busy}
				class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium transition hover:bg-gray-50 disabled:opacity-50 dark:border-neutral-600 dark:hover:bg-neutral-800"
			>
				Confirm with a passkey
			</button>
		{:else}
			<p class="text-sm text-gray-500 dark:text-neutral-400">
				Changing your sign-in email needs a sign-in from the last ten minutes.
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
		{#if error}
			<p class="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
		{/if}
	</div>
</div>
