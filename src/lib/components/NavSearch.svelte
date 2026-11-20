<script lang="ts">
	// Persistent directory search, lives in the top nav (so it's on every gated
	// page). Live: typing navigates to the directory with ?q= (debounced), which
	// re-runs the server search. Works without JS too — it's a GET form.
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';

	type Props = { base: string; onNavigate?: () => void };
	const { base, onNavigate }: Props = $props();

	let value = $state($page.url.searchParams.get('q') ?? '');
	let input: HTMLInputElement | undefined = $state();
	let timer: ReturnType<typeof setTimeout> | undefined;

	const membersHref = $derived(`${base}/members`);

	// On the directory, mirror the URL's ?q= (covers back/forward + clear) — but
	// never overwrite what the user is actively typing. Off the directory, leave
	// the box alone so the query persists as you move around.
	$effect(() => {
		const onMembers = $page.route.id === '/group/[slug]/members';
		const urlQ = $page.url.searchParams.get('q') ?? '';
		if (input && document.activeElement === input) return;
		if (onMembers) value = urlQ;
	});

	function navigate() {
		const q = value.trim();
		const target = q ? `${membersHref}?q=${encodeURIComponent(q)}` : membersHref;
		const onMembers = $page.route.id === '/group/[slug]/members';
		// Replace history while refining on the directory; push when arriving from
		// another page so Back returns there. keepFocus so typing isn't interrupted.
		goto(target, { keepFocus: true, noScroll: true, replaceState: onMembers });
	}

	function onInput() {
		clearTimeout(timer);
		timer = setTimeout(navigate, 200);
	}

	function onSubmit(e: SubmitEvent) {
		e.preventDefault();
		clearTimeout(timer);
		navigate();
		// Only on Enter/submit — not per-keystroke — so searching from inside the
		// mobile drawer closes it (revealing results) once the user commits.
		onNavigate?.();
	}

	$effect(() => () => clearTimeout(timer));
</script>

<form method="GET" action={membersHref} onsubmit={onSubmit} class="mx-auto w-full max-w-sm">
	<div class="relative">
		<!-- Heroicon magnifying-glass (mini), light grey — the search affordance
		     alongside the placeholder hint. pointer-events-none so a tap on the
		     icon focuses the input behind it. -->
		<svg
			viewBox="0 0 20 20"
			fill="currentColor"
			class="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-gray-400 dark:text-neutral-500"
			aria-hidden="true"
		>
			<path
				fill-rule="evenodd"
				d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z"
				clip-rule="evenodd"
			/>
		</svg>
		<input
			bind:this={input}
			bind:value
			oninput={onInput}
			name="q"
			type="search"
			aria-label="Search the directory"
			placeholder="e.g. hobby, name, nick, location"
			class="w-full rounded-md border-gray-300 bg-white pl-9 text-sm text-black placeholder:text-gray-400 focus:border-gray-500 focus:ring-gray-500 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500"
		/>
	</div>
</form>
