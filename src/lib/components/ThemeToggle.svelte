<script lang="ts">
	// Floating theme control (bottom-right): a small button showing the current
	// choice that opens a menu to pick System / Light / Dark. Persists in
	// localStorage ('theme' = 'light' | 'dark'; absent = follow the OS) and toggles
	// `.dark` on <html>, which drives Tailwind's class-based dark mode. The no-FOUC
	// bootstrap lives inline in app.html; on "System" it live-tracks OS changes.
	//
	// `extraClass` controls when it shows: the default desktop instance is
	// `hidden md:block`; the mobile instance (rendered only while the drawer is
	// open, in the group layout) passes `md:hidden`.
	import { onMount } from 'svelte';

	type Mode = 'system' | 'light' | 'dark';
	const { extraClass = 'hidden md:block' }: { extraClass?: string } = $props();

	let mode = $state<Mode>('system');
	let open = $state(false);

	const options: { mode: Mode; label: string; short: string }[] = [
		{ mode: 'system', label: 'System theme', short: 'System' },
		{ mode: 'light', label: 'Light theme', short: 'Light' },
		{ mode: 'dark', label: 'Dark theme', short: 'Dark' }
	];

	function systemPrefersDark(): boolean {
		return window.matchMedia('(prefers-color-scheme: dark)').matches;
	}

	function apply(m: Mode): void {
		const dark = m === 'dark' || (m === 'system' && systemPrefersDark());
		document.documentElement.classList.toggle('dark', dark);
		paintThemeColor();
	}

	// The browser chrome takes the accent of the mode the page is in, read back
	// from the skin's stylesheet so it cannot drift from what the pages paint.
	// The layout renders the light accent; hydration writes that value back, so
	// mounting repaints it too.
	function paintThemeColor(): void {
		const root = document.documentElement;
		const accent = getComputedStyle(root).getPropertyValue('--color-accent').trim();
		const meta = document.querySelector('meta[name="theme-color"]');
		if (accent && meta) meta.setAttribute('content', accent);
	}

	function select(m: Mode): void {
		mode = m;
		if (m === 'system') localStorage.removeItem('theme');
		else localStorage.setItem('theme', m);
		apply(m);
		open = false;
	}

	onMount(() => {
		const t = localStorage.getItem('theme');
		mode = t === 'dark' ? 'dark' : t === 'light' ? 'light' : 'system';
		paintThemeColor();
		// Track OS changes while the user is on "System". Storage, not this
		// instance's `mode`, says so: the drawer's instance may have set it.
		const mq = window.matchMedia('(prefers-color-scheme: dark)');
		const onChange = () => {
			const t = localStorage.getItem('theme');
			if (t !== 'light' && t !== 'dark') apply('system');
		};
		mq.addEventListener('change', onChange);
		return () => mq.removeEventListener('change', onChange);
	});
</script>

{#snippet icon(m: Mode, sizeClass: string)}
	<svg viewBox="0 0 20 20" fill="currentColor" class="{sizeClass} shrink-0" aria-hidden="true">
		{#if m === 'system'}
			<path
				fill-rule="evenodd"
				d="M2 4.25A2.25 2.25 0 0 1 4.25 2h11.5A2.25 2.25 0 0 1 18 4.25v8.5A2.25 2.25 0 0 1 15.75 15h-3.105l.401 1.607.104.043A.75.75 0 0 1 12.875 18h-5.75a.75.75 0 0 1-.275-1.35l.104-.043L7.355 15H4.25A2.25 2.25 0 0 1 2 12.75v-8.5Zm2.25-.75a.75.75 0 0 0-.75.75v7.5c0 .414.336.75.75.75h11.5a.75.75 0 0 0 .75-.75v-7.5a.75.75 0 0 0-.75-.75H4.25Z"
				clip-rule="evenodd"
			/>
		{:else if m === 'light'}
			<path
				d="M10 2a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 2ZM10 15a.75.75 0 0 1 .75.75v1.5a.75.75 0 0 1-1.5 0v-1.5A.75.75 0 0 1 10 15ZM10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM15.657 5.404a.75.75 0 1 0-1.06-1.06l-1.061 1.06a.75.75 0 0 0 1.06 1.06l1.06-1.06ZM6.464 14.596a.75.75 0 1 0-1.06-1.06l-1.06 1.06a.75.75 0 0 0 1.06 1.06l1.06-1.06ZM18 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 18 10ZM5 10a.75.75 0 0 1-.75.75h-1.5a.75.75 0 0 1 0-1.5h1.5A.75.75 0 0 1 5 10ZM14.596 15.657a.75.75 0 0 0 1.06-1.06l-1.06-1.061a.75.75 0 1 0-1.06 1.06l1.06 1.06ZM5.404 6.464a.75.75 0 0 0 1.06-1.06l-1.06-1.06a.75.75 0 1 0-1.061 1.06l1.06 1.06Z"
			/>
		{:else}
			<path
				d="M7.455 2.004a.75.75 0 0 1 .26.77 7 7 0 0 0 9.958 7.967.75.75 0 0 1 1.067.853A8.5 8.5 0 1 1 6.647 1.921a.75.75 0 0 1 .808.083Z"
			/>
		{/if}
	</svg>
{/snippet}

<svelte:window onkeydown={(e) => e.key === 'Escape' && (open = false)} />

<!-- Outside-click catcher -->
{#if open}
	<button
		type="button"
		tabindex="-1"
		aria-hidden="true"
		class="fixed inset-0 z-40 cursor-default"
		onclick={() => (open = false)}
	></button>
{/if}

<div class="fixed bottom-4 right-4 z-50 {extraClass}">
	<button
		type="button"
		onclick={() => (open = !open)}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-label="Theme"
		title="Theme"
		class="flex items-center justify-center rounded-full bg-white/70 p-1.5 text-gray-500 shadow-sm ring-1 ring-black/10 backdrop-blur transition hover:text-gray-900 dark:bg-neutral-800/70 dark:text-neutral-400 dark:ring-white/15 dark:hover:text-neutral-100"
	>
		{@render icon(mode, 'size-3.5')}
	</button>

	{#if open}
		<div
			role="menu"
			aria-label="Theme"
			class="absolute bottom-full right-0 mb-2 w-36 overflow-hidden rounded-lg bg-white py-1 shadow-lg ring-1 ring-black/5 dark:bg-neutral-900 dark:ring-white/10"
		>
			{#each options as o (o.mode)}
				<button
					type="button"
					role="menuitemradio"
					aria-checked={mode === o.mode}
					onclick={() => select(o.mode)}
					class="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition hover:bg-black/5 dark:hover:bg-white/5 {mode ===
					o.mode
						? 'text-gray-900 dark:text-neutral-100'
						: 'text-gray-600 dark:text-neutral-400'}"
				>
					{@render icon(o.mode, 'size-4')}
					<span class="flex-1">{o.short}</span>
					{#if mode === o.mode}
						<svg viewBox="0 0 20 20" fill="currentColor" class="size-4 shrink-0" aria-hidden="true">
							<path
								fill-rule="evenodd"
								d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z"
								clip-rule="evenodd"
							/>
						</svg>
					{/if}
				</button>
			{/each}
		</div>
	{/if}
</div>
