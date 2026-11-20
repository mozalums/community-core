<script lang="ts">
	import { brand, site } from '$skin/skin.yaml';
	// Three states, all of them reachable from the same emailed URL: confirm the
	// link, tell the visitor it is dead and take them out of that, or acknowledge
	// the replacement we just sent.
	import { applyAction, enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { onMount, tick } from 'svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import type { PageData, ActionData } from './$types';

	const { data, form }: { data: PageData; form: ActionData } = $props();

	// Spending the token needs a POST — a prefetching scanner would burn a GET —
	// but nobody should have to press a button to sign in, so hydration presses
	// it. What the member sees is what they saw before the token moved off the
	// GET: a blink of this page, then where they were going. A scanner that runs
	// JS gets through too; the one this is for, Defender Safe Links, only
	// prefetches.
	let confirmForm = $state<HTMLFormElement | null>(null);
	// Only true while a POST is actually in flight, so the spinner is never
	// spinning over nothing: without JS it never turns at all, and it stops when
	// the submit fails and the button takes over.
	let signing = $state(false);
	let stalled = $state(false);
	let submitted = false;
	let stallTimer: ReturnType<typeof setTimeout> | undefined;

	onMount(async () => {
		if (!data.valid) return;
		// After the mount flush, so `use:enhance` is listening: a submit that beat
		// it would navigate for real, leaving this page in history for Back to
		// find and its spent token to reject.
		await tick();
		if (submitted || !confirmForm) return;
		submitted = true;
		confirmForm.requestSubmit();
		signing = true;
		// Only for a POST that never answers at all. Anything that does answer
		// clears this below, so a slow sign-in can't flash a button on its way to
		// succeeding — the button appears when it is the only way left, never as
		// a progress report.
		stallTimer = setTimeout(() => (stalled = true), 8000);
	});
</script>

<svelte:head>
	<title>Sign in — {site.name}</title>
</svelte:head>

<main
	class="flex min-h-screen flex-col items-center justify-center bg-stone-100 px-6 py-12 text-black dark:bg-neutral-950 dark:text-neutral-100"
>
	<div class="reveal w-full max-w-sm space-y-6 text-center">
		<img src="/{brand.wordmark}" alt={site.name} class="mx-auto h-10 w-auto dark:invert" />

		{#if form?.sent}
			<div class="space-y-2">
				<h1 class="text-2xl font-bold">Check your email</h1>
				<p class="text-black/60 dark:text-neutral-400">
					We sent a sign-in link to<br /><span class="font-medium text-black dark:text-neutral-100"
						>{form.email}</span
					>
				</p>
			</div>
		{:else if data.valid}
			<div class="space-y-2">
				<h1 class="text-2xl font-bold">Signing in...</h1>
				<p class="text-black/60 dark:text-neutral-400">
					Continue as<br /><span class="font-medium text-black dark:text-neutral-100"
						>{data.email}</span
					>
				</p>
			</div>

			{#if signing && !stalled}
				<Spinner class="mx-auto size-5 text-black/40 dark:text-neutral-500" />
			{/if}

			<!-- Visible until hydration takes it away, never the other way round: the
			     reveal used to depend on a timer set in onMount, so a bundle that
			     never loaded left no button and no way to press one. `<noscript>`
			     does not cover that, because scripting is enabled and merely
			     broken. -->
			<form
				method="POST"
				action="?/confirm"
				bind:this={confirmForm}
				class={signing && !stalled ? 'hidden' : ''}
				use:enhance={() =>
					async ({ result }) => {
						clearTimeout(stallTimer);
						if (result.type === 'error') {
							// The submit itself failed — offline, or the POST was blocked.
							// Hand the visitor the button so they can retry.
							signing = false;
							stalled = true;
							return;
						}
						if (result.type === 'redirect') {
							// Replace rather than push: Back must never land on this page
							// and tell a member who just signed in that their link expired.
							await goto(result.location, { replaceState: true, invalidateAll: true });
							return;
						}
						await applyAction(result);
						// Re-peek the now-spent token so the resend form takes over.
						await invalidateAll();
					}}
			>
				<input type="hidden" name="token" value={data.token} />
				<button
					type="submit"
					class="w-full rounded-full bg-accent px-6 py-2.5 text-sm font-medium text-accent-contrast transition hover:opacity-80"
				>
					Sign in
				</button>
			</form>

			<!-- The whole UI without JS: the click that used to be everyone's. -->
			<noscript>
				<form method="POST" action="?/confirm">
					<input type="hidden" name="token" value={data.token} />
					<button
						type="submit"
						class="w-full rounded-full bg-accent px-6 py-2.5 text-sm font-medium text-accent-contrast transition hover:opacity-80"
					>
						Sign in
					</button>
				</form>
			</noscript>
		{:else}
			<div class="space-y-2">
				<h1 class="text-2xl font-bold">Link expired</h1>
				<p class="text-black/60 dark:text-neutral-400">
					This sign-in link has expired or was already used. Enter your email and we'll send a fresh
					one.
				</p>
			</div>

			{#if form?.error}
				<p class="text-sm text-rose-600 dark:text-rose-400">{form.error}</p>
			{/if}

			<form method="POST" action="?/resend" class="space-y-3">
				<label class="sr-only" for="resend-email">Email address</label>
				<input
					id="resend-email"
					type="email"
					name="email"
					required
					autocomplete="email"
					placeholder="you@example.com"
					value={form?.email ?? ''}
					class="w-full rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-black placeholder-gray-400 focus:border-black focus:outline-none dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder-neutral-500 dark:focus:border-white"
				/>
				<button
					type="submit"
					class="w-full rounded-full bg-accent px-6 py-2.5 text-sm font-medium text-accent-contrast transition hover:opacity-80"
				>
					Send me a new link
				</button>
			</form>
		{/if}
	</div>
</main>

<style>
	/* Signing in usually finishes before anyone needs telling it is happening, so
	   this page says nothing for its first 400ms and most members never see it at
	   all — the emailed link goes straight to where it was for. Past that, the
	   sign-in is slow enough to be worth narrating. Deliberately CSS rather than
	   JS: a bundle still downloading is exactly when the message is needed, and
	   that is exactly when JS cannot deliver it. */
	.reveal {
		animation: reveal 150ms ease-out 400ms both;
	}

	@keyframes reveal {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
</style>
