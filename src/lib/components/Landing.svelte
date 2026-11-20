<script lang="ts">
	// Marketing landing for the default group's home page. Solid-color sections,
	// one clear call to action, and a data-driven public showcase at the bottom.
	import Gravatar from '$lib/components/Gravatar.svelte';
	import { id as skinId } from '$skin/skin.yaml';
	import { brand, site } from '$skin/skin.yaml';

	type Props = {
		groupName: string;
		// Where "Login" / "Register" take the visitor (sign in → directory/request),
		// from the page's state-aware logic. Both CTAs share this target.
		connectHref: string;
		// Admin-editable Markdown (group.landing_md) rendered to HTML, shown in the
		// intro blurb below the hero. '' leaves the blurb out.
		landingHtml?: string;
		// The skin's copy/landing-hero.md and copy/landing-band.md, rendered. The
		// hero's level-1 heading is the page's only one. '' leaves either out.
		heroHtml?: string;
		bandHtml?: string;
		// Which of the skin's documents exist, so the footer links only to those.
		documents?: { manifesto: boolean; codeOfConduct: boolean };
		// When set (guest visitor), the CTAs open the sign-in modal instead of
		// navigating; the href stays as a no-JS fallback (→ /login).
		onLogin?: () => void;
		// Primary CTA label (default 'Login' for guests; e.g. 'Enter the directory'
		// for the signed-in /home view) and whether to show the "Register" link.
		ctaLabel?: string;
		showRegister?: boolean;
		// Members who opted in to public display: id, name, and the uploaded
		// avatar's URL id. No address and no md5 of one — this band renders for
		// guests, so it must not send anyone's browser to Gravatar. The closing
		// showcase band only renders when this is non-empty.
		teamMembers?: {
			id: string;
			name: string;
			avatarId: string | null;
		}[];
		// Link base for the current request ('' for the default group's clean root
		// URLs, '/group/<slug>' otherwise). Only the footer's document links need
		// it; every other href on this page arrives pre-resolved.
		base?: string;
		// When set, showcase avatars link to `<profileBase>/members/<id>`. Only
		// passed for viewers who can actually open profiles (community members /
		// dash-access / admin); left null for guests, who'd be bounced to /request.
		profileBase?: string | null;
		// Short commit the running image was built from, or '' when a build gave
		// none. The footer is the only place it surfaces, so a page fetched with
		// curl names the code serving it.
		buildSha?: string;
		// The core release tag the image was built from, or ''.
		coreTag?: string;
	};

	const {
		groupName,
		connectHref,
		landingHtml = '',
		heroHtml = '',
		bandHtml = '',
		documents = { manifesto: false, codeOfConduct: false },
		onLogin,
		ctaLabel = 'Login',
		showRegister = true,
		teamMembers = [],
		base = '',
		profileBase = null,
		buildSha = '',
		coreTag = ''
	}: Props = $props();

	function handleLogin(e: MouseEvent) {
		if (onLogin) {
			e.preventDefault();
			onLogin();
		}
	}

	// Whether showcase avatars link to profiles. Test `!= null` (not truthiness):
	// the default group's base is the empty string '', which is a valid base but
	// falsy — so `profileBase ? …` would wrongly disable links for it.
	const linkable = $derived(profileBase != null);
</script>

<!-- The showcase band below is one tab stop per member, so a keyboard or
     screen-reader visitor needs a way past it. `tabindex="-1"` on the target is
     what makes activating this move focus: without it the browser scrolls and
     leaves focus here, and the next Tab starts over. -->
<a
	href="#landing-main"
	class="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-accent focus:px-5 focus:py-2.5 focus:text-sm focus:font-medium focus:text-accent-contrast"
>
	Skip to main content
</a>

<main id="landing-main" tabindex="-1">
	<!-- 1 — Hero (solid sand) -->
	<section
		class="bg-stone-100 px-6 py-24 text-black dark:bg-neutral-950 dark:text-neutral-100 md:py-32"
	>
		<div class="mx-auto flex max-w-3xl flex-col items-center text-center">
			<img src="/{brand.wordmark}" alt={site.name} class="mb-10 h-12 w-auto dark:invert md:h-16" />
			<div
				class="[&_h1]:text-4xl [&_h1]:font-bold [&_h1]:leading-tight md:[&_h1]:text-6xl [&_p]:mx-auto [&_p]:mt-6 [&_p]:max-w-xl [&_p]:text-lg [&_p]:text-black/70 dark:[&_p]:text-neutral-400"
			>
				{@html heroHtml}
			</div>
			<a
				href={connectHref}
				onclick={handleLogin}
				class="mt-10 inline-flex items-center rounded-full bg-accent px-8 py-3 text-base font-medium text-accent-contrast transition hover:opacity-80"
			>
				{ctaLabel} &rarr;
			</a>
			{#if showRegister}
				<a
					href={connectHref}
					onclick={handleLogin}
					class="mt-3 inline-block text-sm text-gray-600 underline underline-offset-2 dark:text-neutral-400"
				>
					Not yet a member? Register
				</a>
			{/if}
		</div>
	</section>

	<!-- Intro blurb — the only dynamic bit: admin-editable Markdown
     (group.landing_md), shown only when set. -->
	{#if landingHtml}
		<section class="bg-white px-6 py-12 text-black dark:bg-neutral-950 dark:text-neutral-100">
			<div
				class="prose mx-auto max-w-2xl text-center dark:prose-invert prose-headings:text-gray-900 prose-p:text-black/70 prose-a:text-link dark:prose-headings:text-neutral-100 dark:prose-p:text-neutral-300"
			>
				{@html landingHtml}
			</div>
		</section>
	{/if}

	<!-- 2 — Supporting band (solid dark) -->
	{#if bandHtml}
		<section class="bg-neutral-900 px-6 py-24 text-white">
			<div
				class="mx-auto max-w-3xl text-center [&_h2]:mx-auto [&_h2]:max-w-xl [&_h2]:text-3xl [&_h2]:font-bold [&_p]:mx-auto [&_p]:mt-4 [&_p]:max-w-lg [&_p]:text-lg [&_p]:text-white/60"
			>
				{@html bandHtml}
			</div>
		</section>
	{/if}

	<!-- 3 — Public showcase (solid grey) — opted-in members, name + photo. -->
	{#if teamMembers.length}
		<section class="bg-neutral-600 px-6 py-16 text-white" aria-labelledby="showcase-heading">
			<h2 id="showcase-heading" class="sr-only">Members</h2>
			<div class="mx-auto flex max-w-3xl flex-wrap items-start justify-center gap-x-8 gap-y-6">
				{#each teamMembers as m (m.id)}
					<svelte:element
						this={linkable ? 'a' : 'div'}
						href={linkable ? `${profileBase}/members/${m.id}` : undefined}
						class="flex w-24 flex-col items-center gap-2 text-center {linkable
							? 'transition hover:opacity-80'
							: ''}"
					>
						<Gravatar hash={null} name={m.name} size={72} avatarId={m.avatarId} />
						<p class="text-sm leading-tight">{m.name}</p>
					</svelte:element>
				{/each}
			</div>
		</section>
	{/if}

	<!-- 4 — Closing CTA (solid sand) — register prompt reusing the top login action. -->
	{#if showRegister}
		<section class="bg-stone-100 px-6 py-20 text-black dark:bg-neutral-950 dark:text-neutral-100">
			<div class="mx-auto flex max-w-3xl flex-col items-center text-center">
				<a
					href={connectHref}
					onclick={handleLogin}
					class="mt-10 inline-flex items-center rounded-full bg-accent px-8 py-3 text-base font-medium text-accent-contrast transition hover:opacity-80"
				>
					{ctaLabel} &rarr;
				</a>
				{#if showRegister}
					<a
						href={connectHref}
						onclick={handleLogin}
						class="mt-3 inline-block text-sm text-gray-600 underline underline-offset-2 dark:text-neutral-400"
					>
						Not yet a member? Register
					</a>
				{/if}
			</div>
		</section>
	{/if}
</main>

<!-- The page's only contentinfo landmark. Site-wide documents (privacy notice,
     terms) belong in this list rather than in a second <footer>, which would
     give the document two contentinfo landmarks and neither would be canonical. -->
<footer class="bg-stone-100 px-6 py-12 text-black dark:bg-neutral-950 dark:text-neutral-100">
	<div class="mx-auto flex max-w-3xl flex-col items-center gap-4 text-center">
		{#if documents.manifesto || documents.codeOfConduct}
			<nav aria-label="Site documents">
				<ul class="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm">
					{#if documents.manifesto}
						<li>
							<a href="{base}/manifesto" class="underline underline-offset-2 hover:no-underline"
								>Manifesto</a
							>
						</li>
					{/if}
					{#if documents.codeOfConduct}
						<li>
							<a
								href="{base}/code-of-conduct"
								class="underline underline-offset-2 hover:no-underline">Code of Conduct</a
							>
						</li>
					{/if}
				</ul>
			</nav>
		{/if}
		<p class="text-sm text-black/70 dark:text-neutral-400">{groupName}</p>
		<!-- The commit this image was built from and the skin compiled into it, so
		     `curl / | grep` answers what is deployed without a login. Omitted
		     rather than shown as a placeholder when a build supplied none, which
		     is every build outside the deploy. -->
		{#if buildSha}
			<p class="font-mono text-xs text-black/40 dark:text-neutral-600">
				build {buildSha}{coreTag ? ` · core ${coreTag}` : ''} · skin {skinId}
			</p>
		{/if}
	</div>
</footer>
