<script lang="ts">
	// Passkey sign-in for every sign-in form: the /login page and the landing
	// page's modal. The form around it owns the email input, which must carry
	// `autocomplete="username webauthn"` for the browser to offer passkeys in
	// that field's autofill.
	import { onMount } from 'svelte';
	import {
		WebAuthnAbortService,
		browserSupportsWebAuthn,
		browserSupportsWebAuthnAutofill,
		startAuthentication
	} from '@simplewebauthn/browser';

	const { callbackUrl }: { callbackUrl: string } = $props();

	let error = $state('');
	let busy = $state(false);
	// Rendered on the server, hidden after mount where the browser has no WebAuthn.
	let supported = $state(true);

	async function options() {
		const res = await fetch('/auth/passkey', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ step: 'options' })
		});
		if (!res.ok) throw new Error('options');
		return res.json();
	}

	async function finish(response: unknown) {
		const res = await fetch('/auth/passkey', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ step: 'verify', response, callbackUrl })
		});
		if (!res.ok) {
			error =
				res.status === 429
					? 'Too many sign-in attempts. Wait a few minutes and try again.'
					: 'That passkey was not accepted. Use the email link instead.';
			return;
		}
		const { redirect } = await res.json();
		window.location.assign(redirect);
	}

	async function signIn() {
		error = '';
		busy = true;
		try {
			await finish(await startAuthentication({ optionsJSON: await options() }));
		} catch {
			error = 'No passkey was used. You can sign in with the email link instead.';
		} finally {
			busy = false;
		}
	}

	// Conditional mediation: the browser lists this site's passkeys in the email
	// field's autofill, and picking one signs in with no button pressed. The
	// ceremony stays pending until then; the button aborts it, and so does
	// closing the modal, which would otherwise leave the browser holding a
	// request for a field that no longer exists.
	onMount(() => {
		supported = browserSupportsWebAuthn();
		void (async () => {
			if (!(await browserSupportsWebAuthnAutofill())) return;
			const response = await startAuthentication({
				optionsJSON: await options(),
				useBrowserAutofill: true
			});
			await finish(response);
		})().catch(() => {});
		return () => WebAuthnAbortService.cancelCeremony();
	});
</script>

{#if supported}
	<div class="space-y-2" data-passkey-signin>
		<button
			type="button"
			onclick={signIn}
			disabled={busy}
			class="w-full rounded-full border border-gray-300 px-6 py-2.5 text-sm font-medium transition hover:bg-white disabled:opacity-60 dark:border-neutral-600 dark:hover:bg-neutral-800"
		>
			Sign in with a passkey
		</button>
		{#if error}
			<p class="text-sm text-rose-600 dark:text-rose-400">{error}</p>
		{/if}
	</div>
{/if}
