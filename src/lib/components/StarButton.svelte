<script module lang="ts">
	export type StarState = { starred: boolean };

	// Flips the star at once and persists in the background; a failed or
	// refused request puts back the state the click started from.
	export async function toggleStar(
		state: StarState,
		endpoint: string,
		fetcher: typeof fetch = fetch
	): Promise<void> {
		const was = state.starred;
		state.starred = !was;
		try {
			const res = await fetcher(endpoint, { method: was ? 'DELETE' : 'POST' });
			if (!res.ok) throw new Error('star request failed');
		} catch {
			state.starred = was;
		}
	}
</script>

<script lang="ts">
	type Props = {
		base: string;
		memberId: string;
		starred: boolean;
		class?: string;
	};
	const { base, memberId, starred: initial, class: className = '' }: Props = $props();

	const endpoint = $derived(`${base}/members/${memberId}/star`);

	// Re-seeded whenever the server sends a new value or the instance is handed
	// another member (SvelteKit reuses the profile page across ids), overridden
	// locally by a click in between.
	let starred = $derived(initial);

	// A request settles against the member it was sent for: once the instance
	// shows someone else, its result or rollback must not touch their star.
	function toggle() {
		const target = endpoint;
		const state: StarState = {
			get starred() {
				return starred;
			},
			set starred(v) {
				if (endpoint === target) starred = v;
			}
		};
		toggleStar(state, target);
	}
</script>

<button
	type="button"
	onclick={toggle}
	aria-pressed={starred}
	aria-label={starred ? 'Unstar' : 'Star'}
	title={starred ? 'Starred' : 'Star'}
	class="rounded p-0.5 transition {className} {starred
		? 'text-yellow-400'
		: 'text-gray-300 hover:text-gray-400 dark:text-neutral-600 dark:hover:text-neutral-500'}"
>
	<svg
		viewBox="0 0 24 24"
		fill={starred ? 'currentColor' : 'none'}
		stroke="currentColor"
		stroke-width="1.5"
		class="size-5"
		aria-hidden="true"
	>
		<path
			stroke-linecap="round"
			stroke-linejoin="round"
			d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.884a.563.563 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z"
		/>
	</svg>
</button>
