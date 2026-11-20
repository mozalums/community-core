<script lang="ts">
	// Member profile image. The initials disc is the element; a photo paints over
	// it once one loads, from our uploaded avatar at /avatar/<public id> and then
	// from Gravatar. Painting the disc first rather than after a 404 is what keeps
	// a grid of members from rendering as blank circles that pop in as round trips
	// land. `avatarId` comes from the server (null = no uploaded photo); it is
	// required so a new call site cannot silently drop a member's photo. The id is
	// not derived from the address on purpose — see src/routes/avatar/[id]/+server.ts.
	//
	// `hash` is md5(address), minted server-side, and null means "do not consult
	// Gravatar for this person". Public pages pass null: a guest has no
	// relationship with the people in the showcase, so their browser must not
	// announce the membership list to Automattic, and the hash is a membership
	// oracle for anyone holding a candidate address. Members-only pages pass a
	// hash. The branded GravatarHash is what stops a call site passing an address
	// where the md5 belongs.
	import { gravatarUrl, type GravatarHash } from '$lib/gravatar';
	import { colorizer } from '$lib/utils/colorizer';
	import { initialsFromSubject } from '$lib/utils/avatar';

	type Props = {
		hash: GravatarHash | null;
		avatarId: string | null;
		name?: string | null;
		size?: number;
	};
	const { hash, avatarId, name = null, size = 40 }: Props = $props();

	// Tried in order, each miss advancing to the next. 2× the display size for
	// retina; d=404 so a member with no Gravatar errors through to the disc
	// instead of being handed a generated identicon.
	const sources = $derived([
		...(avatarId ? [`/avatar/${avatarId}`] : []),
		...(hash ? [gravatarUrl(hash, { size: size * 2, d: '404' })] : [])
	]);
	const initials = $derived(initialsFromSubject(name));
	// Seeded on the name, not the hash: public pages carry no hash, and a seed
	// that changes between the showcase and the directory gives one member two
	// colors. The name is on every call site and already drives the initials.
	const color = $derived(colorizer(name ?? ''));

	// Counts <img> errors, and resets when the identity or the photo changes (a
	// reused instance). Exhausting `sources` leaves the disc alone on screen.
	let missed = $state(0);
	$effect(() => {
		void hash;
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
