<script lang="ts">
	// Member profile image. The initials disc is the element; a photo paints over
	// it once /avatar/<public id> answers, which serves an upload or a Gravatar
	// the server fetched for that member. Painting the disc first rather than after
	// a 404 is what keeps a grid of members from rendering as blank circles that
	// pop in as round trips land. `avatarId` comes from the server (null = no
	// stored photo) and is required so a new call site cannot silently drop a
	// member's photo. The id is not derived from the address on purpose; see
	// src/routes/avatar/[id]/+server.ts.
	//
	// The browser never contacts Gravatar and never sees a hash of an address:
	// the hash is a membership oracle for anyone holding a candidate address, and
	// a hotlinked <img> announces each member to Automattic from the viewer's
	// browser. A member whose Gravatar the server has not fetched yet (it does so
	// at sign-in) shows initials. The component keeps its name because the
	// photo's most common source is still Gravatar.
	import { colorizer } from '$lib/utils/colorizer';
	import { initialsFromSubject } from '$lib/utils/avatar';

	type Props = {
		avatarId: string | null;
		name?: string | null;
		size?: number;
	};
	const { avatarId, name = null, size = 40 }: Props = $props();

	const sources = $derived(avatarId ? [`/avatar/${avatarId}`] : []);
	const initials = $derived(initialsFromSubject(name));
	// Seeded on the name, which every call site has, so one member gets the same
	// color on the showcase and in the directory.
	const color = $derived(colorizer(name ?? ''));

	// Counts <img> errors, and resets when the identity or the photo changes (a
	// reused instance). Exhausting `sources` leaves the disc alone on screen.
	let missed = $state(0);
	$effect(() => {
		void avatarId;
		missed = 0;
	});
	const src = $derived(sources[missed] ?? null);
</script>

<span
	class="relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium text-white"
	style="width:{size}px;height:{size}px;background:{color};font-size:{Math.round(size * 0.4)}px"
>
	<span aria-hidden="true">{initials}</span>
	{#if src}
		<!-- No background of its own: an image still loading is transparent, so the
		     disc underneath is what the visitor sees until the photo paints. -->
		<img
			{src}
			alt={name ?? ''}
			width={size}
			height={size}
			loading="lazy"
			onerror={() => (missed += 1)}
			class="absolute inset-0 h-full w-full rounded-full object-cover"
		/>
	{/if}
</span>
