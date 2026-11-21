<script lang="ts">
	import { untrack } from 'svelte';

	type Props = {
		// GET <endpoint>?name=… answers { status, name?, message? }.
		endpoint: string;
		// The form control's name.
		name: string;
		// What the input starts with: the stored username, or a refused save's echo.
		value: string;
		// The stored username, so clearing it can say what saving will do.
		current: string;
		// A refused save's message for this field.
		error?: string;
		delay?: number;
	};
	const { endpoint, name, value, current, error = '', delay = 400 }: Props = $props();

	type Answer = { status: string; name?: string; message?: string };

	// Seeded once; from then on the input is the member's to type in.
	let typed = $state(untrack(() => value));
	let line = $state('');
	let kind = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: AbortController | undefined;

	function show(next: string, text: string) {
		kind = next;
		line = text;
	}

	function describe(a: Answer, asked: string): string {
		const shown = a.name ?? asked.trim().toLowerCase();
		switch (a.status) {
			case 'available':
				return `${shown} is available.`;
			case 'yours':
				return `${shown} is already yours.`;
			case 'taken':
				return `${shown} is taken.`;
			case 'reserved':
				return `${shown} is reserved.`;
			case 'invalid':
				return `Not allowed: ${a.message}.`;
			default:
				return a.message ? `${a.message}.` : 'Could not check that name; saving will check it.';
		}
	}

	async function check(asked: string) {
		const controller = new AbortController();
		inFlight = controller;
		try {
			const res = await fetch(`${endpoint}?name=${encodeURIComponent(asked)}`, {
				signal: controller.signal
			});
			const answer: Answer = await res.json();
			if (inFlight !== controller) return;
			show(answer.status, describe(answer, asked));
		} catch {
			if (controller.signal.aborted) return;
			show('error', 'Could not check that name; saving will check it.');
		}
	}

	// One request per pause in typing: each keystroke restarts the wait and
	// cancels whatever check is still open, so an answer for an older spelling
	// never lands under a newer one.
	function oninput(e: Event) {
		typed = (e.currentTarget as HTMLInputElement).value;
		clearTimeout(timer);
		inFlight?.abort();
		inFlight = undefined;
		const asked = typed;
		if (!asked.trim()) {
			show(
				current ? 'clearing' : '',
				current
					? `Saving with this empty removes ${current}; your profile goes back to its id, and links to ${current} keep working.`
					: ''
			);
			return;
		}
		show('checking', '');
		timer = setTimeout(() => check(asked), delay);
	}

	// A refused save (the name was taken between the check and the save, or
	// broke a rule) speaks last: a pending or open check is dropped, because its
	// answer predates the save and would otherwise overwrite the refusal. The
	// next keystroke starts a fresh one.
	$effect(() => {
		if (!error) return;
		clearTimeout(timer);
		inFlight?.abort();
		inFlight = undefined;
		show('error', error);
	});

	$effect(() => () => {
		clearTimeout(timer);
		inFlight?.abort();
	});
</script>

<input
	id="f-username"
	{name}
	value={typed}
	{oninput}
	autocomplete="off"
	autocapitalize="none"
	spellcheck="false"
	aria-describedby="f-username-status f-username-help"
	aria-invalid={kind === 'invalid' || kind === 'taken' || kind === 'reserved' || kind === 'error'
		? 'true'
		: undefined}
	class="w-full rounded-md border-gray-300 bg-white text-sm text-black placeholder:text-gray-400 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500"
/>
<p id="f-username-help" class="mt-1 text-xs text-gray-400 dark:text-neutral-500">
	Optional. 3 to 30 letters, digits or hyphens; your profile then lives at
	/members/&lt;username&gt;.
</p>
<p
	id="f-username-status"
	aria-live="polite"
	data-status={kind}
	class="mt-1 text-sm {kind === 'available' || kind === 'yours'
		? 'text-green-700 dark:text-green-400'
		: kind === 'clearing'
			? 'text-gray-500 dark:text-neutral-400'
			: 'text-red-600 dark:text-red-400'}"
>
	{line}
</p>
