<script lang="ts">
	// On-page sign-in modal: capture an email and POST it to /auth/magic/send,
	// which emails a single-use magic link. This is the enhanced entry point; the
	// same flow works without JS via the /login page.
	import { brand, site } from '$skin/skin.yaml';

	let {
		open = $bindable(false),
		callbackUrl = '/members'
	}: { open?: boolean; callbackUrl?: string } = $props();

	let email = $state('');
	let status = $state<'idle' | 'sending' | 'sent' | 'error'>('idle');
	let invalid = $state(false);
	let inputEl = $state<HTMLInputElement>();

	const isValidEmail = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

	// Focus the email field whenever the form is shown so pressing Enter always
	// submits it (implicit form submission only fires when focus is in a field).
	$effect(() => {
		if (open && status !== 'sent') inputEl?.focus();
	});

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (status === 'sending') return;
		// Validate in JS (the form is `novalidate`) so pressing Enter always gives
		// feedback — a bad/empty email shows an inline message instead of the
		// browser's easily-missed validation bubble.
		const value = email.trim();
		if (!isValidEmail(value)) {
			invalid = true;
			return;
		}
		invalid = false;
		status = 'sending';
		try {
			const res = await fetch('/auth/magic/send', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ email: email.trim(), callbackUrl })
			});
			status = res.ok ? 'sent' : 'error';
		} catch {
			status = 'error';
		}
	}

	function close() {
		open = false;
		// Reset once the overlay is gone so reopening starts fresh.
		setTimeout(() => {
			status = 'idle';
			email = '';
			invalid = false;
		}, 200);
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (open && e.key === 'Escape') close();
	}}
/>

{#if open}
	<div class="fixed inset-0 z-50 flex items-center justify-center px-4">
		<button class="absolute inset-0 bg-black/40" aria-label="Close" onclick={close}></button>

		<div
			class="relative w-full max-w-sm rounded-2xl bg-white p-8 shadow-xl dark:bg-neutral-900"
			role="dialog"
			aria-modal="true"
			aria-label="Sign in to {site.name}"
		>
			<button
				class="absolute right-4 top-4 text-gray-400 transition hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-400"
				aria-label="Close"
				onclick={close}
			>
				<svg viewBox="0 0 20 20" fill="currentColor" class="size-5" aria-hidden="true">
					<path
						d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"
					/>
				</svg>
			</button>

			<img src="/{brand.wordmark}" alt={site.name} class="mx-auto mb-6 h-8 w-auto dark:invert" />

			{#if status === 'sent'}
				<div class="text-center">
					<h2 class="text-lg font-bold text-black dark:text-neutral-100">Check your email</h2>
					<p class="mt-2 text-sm text-gray-600 dark:text-neutral-400">
						We sent a sign-in link to<br /><span
							class="font-medium text-black dark:text-neutral-100">{email}</span
						>
					</p>
					<button
						class="mt-6 text-sm text-gray-500 underline underline-offset-2 hover:text-gray-700 dark:text-neutral-400 dark:hover:text-neutral-300"
						onclick={() => (status = 'idle')}
					>
						Use a different email
					</button>
				</div>
			{:else}
				<div class="text-center">
					<h2 class="text-lg font-bold text-black dark:text-neutral-100">Sign in to {site.name}</h2>
					<p class="mt-1 text-sm text-gray-600 dark:text-neutral-400">
						Enter your email and we'll send you a sign-in link.
					</p>
				</div>
				<form class="mt-6 space-y-3" novalidate onsubmit={submit}>
					<div class="space-y-1 text-left">
						<label for="login-modal-email" class="block text-sm font-medium">Email address</label>
						<input
							id="login-modal-email"
							type="email"
							required
							autocomplete="email"
							placeholder="you@example.com"
							bind:this={inputEl}
							bind:value={email}
							oninput={() => (invalid = false)}
							aria-invalid={invalid}
							class="w-full rounded-lg border bg-white px-4 py-2.5 text-black placeholder-gray-400 focus:outline-none dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder-neutral-500 {invalid
								? 'border-rose-500 focus:border-rose-500 dark:border-rose-500'
								: 'border-gray-300 focus:border-black dark:border-neutral-600 dark:focus:border-white'}"
						/>
					</div>
					<button
						type="submit"
						disabled={status === 'sending'}
						class="w-full rounded-full bg-accent px-6 py-2.5 text-sm font-medium text-accent-contrast transition hover:opacity-80 disabled:opacity-60"
					>
						{status === 'sending' ? 'Sending…' : 'Send me a sign-in link'}
					</button>
					{#if invalid}
						<p class="text-center text-sm text-rose-600 dark:text-rose-400">
							Please enter a valid email address.
						</p>
					{:else if status === 'error'}
						<p class="text-center text-sm text-rose-600 dark:text-rose-400">
							Something went wrong. Please try again.
						</p>
					{/if}
				</form>
			{/if}
		</div>
	</div>
{/if}
