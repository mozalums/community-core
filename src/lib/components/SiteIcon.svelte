<!-- A site's icon. Core's are Font Awesome Free glyphs (site-glyphs.ts),
     drawn from their path data rather than inserted as markup. A skin's own
     site names a file it serves, shown as an image. Decorative either way:
     the site's name is always written beside it. -->
<script lang="ts">
	import { GLYPHS } from '../site-glyphs';

	const { icon, class: cls = 'size-4' }: { icon: string; class?: string } = $props();
	const g = $derived(Object.hasOwn(GLYPHS, icon) ? GLYPHS[icon] : undefined);
</script>

{#if icon.startsWith('/')}
	<img src={icon} alt="" aria-hidden="true" class="{cls} shrink-0" />
{:else if g}
	<svg viewBox={g.viewBox} fill="currentColor" aria-hidden="true" class="{cls} shrink-0"
		><path d={g.d} /></svg
	>
{/if}
