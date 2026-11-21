<script lang="ts">
	import { untrack } from 'svelte';
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import { page } from '$app/stores';
	import Breadcrumbs from '$lib/components/Breadcrumbs.svelte';
	import Gravatar from '$lib/components/Gravatar.svelte';
	import Spinner from '$lib/components/Spinner.svelte';
	import Passkeys from '$lib/components/Passkeys.svelte';
	import EmailChange from '$lib/components/EmailChange.svelte';
	import UsernameField from '$lib/components/UsernameField.svelte';
	import { groupBase } from '$lib/group-nav';
	import {
		COUNTRIES,
		YEARS,
		SIZES,
		DIALING_CODES,
		CITIES_BY_COUNTRY,
		matchDialingCode
	} from '$lib/data/field-options';
	import Combobox from '$lib/components/Combobox.svelte';
	import type { PageData, ActionData } from './$types';

	const { data, form }: { data: PageData; form: ActionData } = $props();

	const base = $derived(groupBase($page.url.pathname, data.group.slug));
	const profileHref = $derived(`${base}/members/${data.ref}`);
	const avatarEndpoint = $derived(`${base}/members/${data.ref}/avatar`);

	let saving = $state(false);

	// "Associated with" is mandatory (≥1 checkbox or Other text). Enforced client-
	// side in the submit handler below, since native `required` can't express
	// "at least one of these boxes".
	let affError = $state('');
	let affCard = $state<HTMLElement | null>(null);

	// Google Sheets writes can be slow — cycle reassuring messages on the button so
	// a long save doesn't feel frozen. Advances every couple seconds, holding on the
	// last one.
	let saveMsg = $state('Save changes');
	let msgTimer: ReturnType<typeof setInterval> | undefined;
	const SAVE_MESSAGES = [
		'Saving…',
		'One more sec…',
		'Ouch, this is slow…',
		'OK, I promise — almost done…',
		'Any second now…'
	];
	function startSaveMessages() {
		let i = 0;
		saveMsg = SAVE_MESSAGES[0];
		clearInterval(msgTimer);
		msgTimer = setInterval(() => {
			i = Math.min(i + 1, SAVE_MESSAGES.length - 1);
			saveMsg = SAVE_MESSAGES[i];
		}, 2500);
	}
	function stopSaveMessages() {
		clearInterval(msgTimer);
		msgTimer = undefined;
	}
	$effect(() => () => clearInterval(msgTimer));

	// `form` is the union of the save + delete action results — cast to the shapes
	// we read (save keeps typed values on failure; delete only reports an error).
	// A control's name is a field key the skin chose, and a key may spell a name
	// every object inherits (`toString`), so each table a key or a stored value
	// addresses is read by own entry: a Map, or Object.hasOwn.
	const own = <T,>(record: Record<string, T> | null | undefined, key: string): T | undefined =>
		record && Object.hasOwn(record, key) ? record[key] : undefined;
	const posted = $derived((form as { values?: Record<string, string> } | null)?.values);
	const valueFor = (name: string, fallback: string) => own(posted, name) ?? fallback;
	// The boxes and the free-text "Other" as a refused save posted them, else as stored.
	const choices = $derived(
		(form as { choices?: PageData['affiliations'] } | null)?.choices ?? data.affiliations
	);
	const saveError = $derived((form as { error?: string } | null)?.error ?? '');
	const fieldError = $derived(
		(form as { fieldError?: { name: string; message: string } } | null)?.fieldError
	);
	const errorFor = (name: string) => (fieldError?.name === name ? fieldError.message : '');

	// A browser refuses a scheme-less value in a URL input before it posts, so
	// "linkedin.com/in/x" gets the https:// the server would have given it:
	// when typed, and when rendered, since a stored or echoed bare value left
	// as it is would stop the whole form, unrelated fields included, from saving.
	const withScheme = (v: string) => {
		const t = v.trim();
		return t && !/^[a-z][a-z\d+.-]*:/i.test(t) ? `https://${t}` : v;
	};
	function addScheme(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		input.value = withScheme(input.value);
	}
	const deleteError = $derived((form as { deleteError?: string } | null)?.deleteError ?? '');
	const postedUsername = $derived((form as { username?: string } | null)?.username);
	const released = $derived((form as { released?: string } | null)?.released ?? '');
	const releaseError = $derived((form as { releaseError?: string } | null)?.releaseError ?? '');

	// Guard the destructive delete behind a native confirm — abort if declined.
	// A failure after the purge committed leaves no row for this page to load,
	// so the retry lives on the removal page instead.
	const enhanceDelete: SubmitFunction = ({ cancel }) => {
		if (
			!confirm(
				'Delete your profile? This permanently removes your directory listing and signs you out. This cannot be undone.'
			)
		) {
			cancel();
			return;
		}
		return async ({ result, update }) => {
			if (result.type === 'failure' && result.data?.removalPending) {
				window.location.assign(`${base}/removal/${data.id}`);
				return;
			}
			await update();
		};
	};

	// Bio renders on its own (top); private fields in their own section; the rest
	// in the public grid.
	const allFields = $derived(data.fields ?? []);
	const bioField = $derived(allFields.find((f) => f.bio && !f.private));
	const gridFields = $derived(allFields.filter((f) => f !== bioField && !f.private));
	const privateFields = $derived(allFields.filter((f) => f.private));

	// --- Dropdown option lists, vendored from the sheet's Lists/Lists2 tabs ---
	type Field = NonNullable<PageData['fields']>[number];
	// A field offers a list only where the skin's `options` names one, and is
	// required only where the skin says so. Its key decides neither: a key is a
	// storage name, and another skin may give `startYear` to a free-text field.
	// Countries and cities are absent here because the city list follows the
	// chosen country.
	const OPTION_LISTS = new Map<string, string[]>([
		['years', YEARS],
		['sizes', SIZES],
		['dialingCodes', DIALING_CODES]
	]);
	// A list too long for a native select's type-ahead gets a filterable
	// combobox, searched by this matcher.
	const OPTION_SEARCH = new Map<string, (option: string, query: string) => boolean>([
		['dialingCodes', matchDialingCode]
	]);
	// Keep an existing (possibly non-listed) value selectable so a swap never drops data.
	const withCurrent = (list: string[], cur: string) =>
		cur && !list.includes(cur) ? [cur, ...list] : list;
	// City suggestions depend on the chosen country; seed each from the
	// failed-save value (no-JS reload) or the stored one.
	const seed = (options: Field['options']) => {
		const f = data.fields?.find((x) => x.options === options);
		if (!f) return '';
		return (
			(own((form as { values?: Record<string, string> } | null)?.values, f.name) ?? f.value) || ''
		);
	};
	let selectedCountry = $state(untrack(() => seed('countries')));
	const cityOptions = $derived(own(CITIES_BY_COUNTRY, selectedCountry) ?? []);
	let selectedCity = $state(untrack(() => seed('cities')));

	// --- Profile photo (uploads immediately, independent of the field-save form) ---
	let fileInput = $state<HTMLInputElement | null>(null);
	let busy = $state(false);
	let photoError = $state('');
	let previewUrl = $state<string | null>(null);
	let removed = $state(false);
	// Whether the widget currently has a photo (offer Remove), and whether the
	// Gravatar should try the uploaded /avatar image.
	const hasPhoto = $derived(previewUrl !== null || (!!data.avatarId && !removed));
	const gravatarAvatarId = $derived(removed ? null : data.avatarId);

	const MAX = 2 * 1024 * 1024;
	const OK_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

	async function onFile(e: Event) {
		photoError = '';
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		if (!OK_TYPES.includes(file.type)) {
			photoError = 'Use a JPEG, PNG, or WebP image.';
			input.value = '';
			return;
		}
		if (file.size > MAX) {
			photoError = 'Image must be 2 MB or smaller.';
			input.value = '';
			return;
		}
		busy = true;
		try {
			const fd = new FormData();
			fd.append('photo', file);
			const res = await fetch(avatarEndpoint, { method: 'POST', body: fd });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				photoError = body.error ?? 'Upload failed. Please try again.';
			} else {
				if (previewUrl) URL.revokeObjectURL(previewUrl);
				previewUrl = URL.createObjectURL(file);
				removed = false;
			}
		} catch {
			photoError = 'Upload failed. Please try again.';
		} finally {
			busy = false;
			input.value = '';
		}
	}

	async function removePhoto() {
		photoError = '';
		busy = true;
		try {
			const res = await fetch(avatarEndpoint, { method: 'DELETE' });
			if (!res.ok) {
				photoError = 'Could not remove photo.';
			} else {
				if (previewUrl) URL.revokeObjectURL(previewUrl);
				previewUrl = null;
				removed = true;
			}
		} catch {
			photoError = 'Could not remove photo.';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title
		>{data.welcome ? 'Complete your profile' : `Edit ${data.editName ?? 'profile'}`} — {data.group
			.name}</title
	>
</svelte:head>

<!-- Renders one editable field's control: a dropdown where the skin gives the
     field an option list (the city list following the chosen country), else a
     text input/textarea. Existing off-list values are preserved. -->
{#snippet fieldControl(f: Field)}
	{#if f.options === 'countries'}
		<select
			id={`f-${f.name}`}
			name={f.name}
			required={f.required}
			bind:value={selectedCountry}
			class="w-full rounded-md border-gray-300 bg-white text-sm text-black dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
		>
			<option value="">—</option>
			{#each withCurrent(COUNTRIES, selectedCountry) as o (o)}<option value={o}>{o}</option>{/each}
		</select>
	{:else if f.options === 'cities'}
		<!-- Dependent on the chosen country; Town covers anywhere not in the list. -->
		<select
			id={`f-${f.name}`}
			name={f.name}
			required={f.required}
			bind:value={selectedCity}
			class="w-full rounded-md border-gray-300 bg-white text-sm text-black dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
		>
			<option value="">—</option>
			{#each withCurrent(cityOptions, selectedCity) as o (o)}<option value={o}>{o}</option>{/each}
		</select>
	{:else if f.options && OPTION_LISTS.has(f.options)}
		{@const cur = valueFor(f.name, f.value)}
		{@const search = OPTION_SEARCH.get(f.options)}
		{#if search}
			<Combobox
				id={`f-${f.name}`}
				name={f.name}
				label={f.label}
				required={f.required}
				options={withCurrent(OPTION_LISTS.get(f.options) ?? [], cur)}
				value={cur}
				match={search}
				class="w-full rounded-md border-gray-300 bg-white text-sm text-black dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
			/>
		{:else}
			<select
				id={`f-${f.name}`}
				name={f.name}
				required={f.required}
				class="w-full rounded-md border-gray-300 bg-white text-sm text-black dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
			>
				<option value="" selected={!cur}>—</option>
				{#each withCurrent(OPTION_LISTS.get(f.options) ?? [], cur) as o (o)}
					<option value={o} selected={o === cur}>{o}</option>
				{/each}
			</select>
		{/if}
	{:else if f.multiline}
		<textarea
			id={`f-${f.name}`}
			name={f.name}
			required={f.required}
			placeholder={f.placeholder ?? ''}
			rows="2"
			value={valueFor(f.name, f.value)}
			class="w-full rounded-md border-gray-300 bg-white text-sm text-black placeholder:text-gray-400 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500"
		></textarea>
	{:else if f.url}
		<input
			id={`f-${f.name}`}
			name={f.name}
			type="url"
			inputmode="url"
			autocomplete="url"
			required={f.required}
			placeholder={f.placeholder ?? ''}
			value={withScheme(valueFor(f.name, f.value))}
			onchange={addScheme}
			aria-invalid={errorFor(f.name) ? 'true' : undefined}
			aria-describedby={errorFor(f.name) ? `f-${f.name}-error` : undefined}
			class="w-full rounded-md border-gray-300 bg-white text-sm text-black placeholder:text-gray-400 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500"
		/>
	{:else}
		<input
			id={`f-${f.name}`}
			name={f.name}
			required={f.required}
			placeholder={f.placeholder ?? ''}
			value={valueFor(f.name, f.value)}
			class="w-full rounded-md border-gray-300 bg-white text-sm text-black placeholder:text-gray-400 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder:text-neutral-500"
		/>
	{/if}
	{#if errorFor(f.name)}
		<p id={`f-${f.name}-error`} class="mt-1 text-sm text-red-600 dark:text-red-400">
			{errorFor(f.name)}
		</p>
	{/if}
{/snippet}

<section class="space-y-4">
	{#if data.welcome}
		<div>
			<h1 class="text-2xl font-bold">Please complete your profile</h1>
			<p class="text-sm text-gray-500 dark:text-neutral-400">This is on first login.</p>
		</div>
	{:else}
		<Breadcrumbs
			items={[
				{ label: 'Directory', href: `${base}/members` },
				{ label: data.editName ?? 'Member', href: profileHref },
				{ label: 'Edit' }
			]}
		/>
	{/if}

	{#if data.fields}
		<!-- autocomplete="off": Firefox restores form-field state from session
		     history on back/forward (and reload), silently overwriting the
		     freshly-loaded sheet values with whatever was typed last visit.
		     This attribute is Firefox's documented switch for that restore. -->
		<form
			method="POST"
			action="?/save"
			autocomplete="off"
			class="space-y-4"
			use:enhance={({ formData, cancel }) => {
				// Mandatory "Associated with": at least one affiliation ticked, or Other filled.
				if (data.affiliations.asked) {
					const hasAff =
						data.affiliations.options.some((a) => formData.get(`aff_${a.key}`) != null) ||
						String(formData.get('otherAffiliations') ?? '').trim() !== '';
					if (!hasAff) {
						affError = 'Select at least one affiliation.';
						cancel();
						affCard?.scrollIntoView({ behavior: 'smooth', block: 'center' });
						return;
					}
				}
				affError = '';
				saving = true;
				startSaveMessages();
				return async ({ update }) => {
					await update();
					saving = false;
					stopSaveMessages();
				};
			}}
		>
			<!-- Field cards stay unclipped (no overflow-hidden) so a combobox popup can
			     extend past the card it opens in; nothing inside paints into the corners. -->
			<div
				class="rounded-xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-neutral-900"
			>
				<div class="border-b border-gray-100 px-6 py-5 dark:border-white/10">
					<h2 class="text-xl font-bold">Public</h2>
					<p class="text-sm text-gray-500 dark:text-neutral-400">
						All fields below, while not mandatory, will be publicly visible within the directory.
					</p>
				</div>

				<!-- Profile photo -->
				<div class="border-b border-gray-100 px-6 py-5 dark:border-white/10">
					<p class="mb-2 text-sm font-medium text-gray-900 dark:text-neutral-100">Profile Photo</p>
					<div class="flex flex-wrap items-center gap-4">
						<span class="shrink-0">
							{#if previewUrl}
								<img
									src={previewUrl}
									alt=""
									width="64"
									height="64"
									class="size-16 rounded-full object-cover"
								/>
							{:else}
								<Gravatar name={data.editName} size={64} avatarId={gravatarAvatarId} />
							{/if}
						</span>

						<input
							bind:this={fileInput}
							type="file"
							accept="image/jpeg,image/png,image/webp"
							class="hidden"
							onchange={onFile}
						/>
						<button
							type="button"
							disabled={busy}
							onclick={() => fileInput?.click()}
							class="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-white/5"
						>
							{busy ? 'Working…' : 'Choose Photo'}
						</button>
						{#if hasPhoto}
							<button
								type="button"
								disabled={busy}
								onclick={removePhoto}
								class="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-50 dark:border-neutral-600 dark:text-red-400 dark:hover:bg-red-950/30"
							>
								Remove
							</button>
						{/if}
						<span class="text-xs text-gray-400 dark:text-neutral-500">
							JPEG, PNG, or WebP. Max 2 MB. Will be shown as a circle.
						</span>
					</div>
					{#if photoError}
						<p class="mt-2 text-sm text-red-600 dark:text-red-400">{photoError}</p>
					{/if}

					<!-- Attribution and the caching disclosure, both required of a free
					     Gravatar integration by Automattic's API Terms of Use: name the
					     service with a link, and say what the app stores and for how
					     long. Here rather than in a policy page because this is where a
					     member decides which picture represents them, and "where does
					     the photo I never uploaded come from" is answerable at the point
					     the question occurs. -->
					<p class="mt-3 text-xs text-gray-400 dark:text-neutral-500">
						No photo here? We look you up on <a
							href="https://gravatar.com"
							rel="noreferrer"
							class="underline hover:text-gray-600 dark:hover:text-neutral-300">Gravatar</a
						>
						by your email address and use that picture if you have one. We fetch it from our own server,
						never from your browser, and keep a copy for up to a week before checking again. Uploading
						a photo here replaces it, and removing yours from Gravatar clears it within the week.
					</p>
				</div>

				{#if data.username}
					<div
						class="grid grid-cols-1 gap-1 border-b border-gray-100 px-6 py-5 dark:border-white/10 sm:grid-cols-3 sm:items-start sm:gap-4"
					>
						<label
							for="f-username"
							class="text-sm font-medium text-gray-900 dark:text-neutral-100 sm:pt-2"
							>Username</label
						>
						<div class="sm:col-span-2">
							<!-- Keyed on the action result so a second refusal with the same
							     message still replaces a check answered in between. -->
							{#key form}
								<UsernameField
									endpoint={`${base}/members/usernames`}
									name={data.username.control}
									value={postedUsername ?? data.username.value}
									current={data.username.value}
									error={errorFor(data.username.control)}
								/>
							{/key}
						</div>
					</div>
				{/if}

				{#if bioField}
					<!-- Bio (the profile free-text slot, rendered as prose at the top of the card),
					     found by role and posted under its field's key. -->
					<div class="border-b border-gray-100 px-6 py-5 dark:border-white/10">
						<label
							for="f-bio"
							class="mb-1 block text-sm font-medium text-gray-900 dark:text-neutral-100"
							>Bio{#if bioField.required}
								<span class="text-gray-400 dark:text-neutral-500">*</span>{/if}</label
						>
						<textarea
							id="f-bio"
							name={bioField.name}
							rows="5"
							required={bioField.required}
							value={valueFor(bioField.name, bioField.value)}
							class="w-full rounded-md border-gray-300 bg-white text-sm text-black dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
						></textarea>
						<p class="mt-1 text-xs text-gray-400 dark:text-neutral-500">
							A short free-text introduction, shown at the top of your profile card.
						</p>
					</div>
				{/if}

				<!-- Public fields -->
				<div class="divide-y divide-gray-100 dark:divide-white/10">
					{#each gridFields as f (f.name)}
						<div class="grid grid-cols-1 gap-1 px-6 py-4 sm:grid-cols-3 sm:items-start sm:gap-4">
							<label
								for={`f-${f.name}`}
								class="text-sm font-medium text-gray-900 dark:text-neutral-100 sm:pt-2"
							>
								{f.label}{#if f.required}
									<span class="text-gray-400 dark:text-neutral-500">*</span>{/if}
							</label>
							<div class="sm:col-span-2">
								{@render fieldControl(f)}
							</div>
						</div>
					{/each}
				</div>
			</div>

			<!-- Public-profile opt-in — drives the homepage showcase (off by default). -->
			{#if data.affiliations.hasPublicProfile}
				<div
					class="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-neutral-900"
				>
					<label class="flex items-start gap-3 px-6 py-5 text-sm">
						<input
							type="checkbox"
							name="publicProfile"
							checked={choices.publicProfile}
							class="mt-0.5 size-4 rounded border-gray-300 text-neutral-900 focus:ring-gray-500 dark:border-neutral-600 dark:text-neutral-100"
						/>
						<span>
							<span class="font-medium text-gray-900 dark:text-neutral-100"
								>Ok to use my profile on public pages</span
							>
							<span class="mt-0.5 block text-gray-500 dark:text-neutral-400">
								When on, your name and photo may appear on the public homepage.
							</span>
						</span>
					</label>
				</div>
			{/if}

			<!-- Associated with: affiliation checkboxes (sheet booleans) + free-text Other. -->
			{#if data.affiliations.asked}
				<div
					bind:this={affCard}
					class="overflow-hidden rounded-xl border shadow-sm {affError
						? 'border-red-400 bg-white dark:bg-neutral-900'
						: 'border-gray-200 bg-white dark:border-white/10 dark:bg-neutral-900'}"
				>
					<div class="border-b border-gray-100 px-6 py-5 dark:border-white/10">
						<h2 class="text-xl font-bold">
							Associated with <span class="text-gray-400 dark:text-neutral-500">*</span>
						</h2>
						{#if data.affiliations.helpHtml}
							<div class="text-sm text-gray-500 dark:text-neutral-400">
								{@html data.affiliations.helpHtml}
							</div>
						{/if}
					</div>
					<div class="space-y-3 px-6 py-5">
						<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
							{#each data.affiliations.options as a (a.key)}
								<label class="flex items-center gap-2 text-sm text-gray-900 dark:text-neutral-100">
									<input
										type="checkbox"
										name={`aff_${a.key}`}
										checked={choices.checks[a.key]}
										onchange={() => (affError = '')}
										class="size-4 rounded border-gray-300 text-neutral-900 focus:ring-gray-500 dark:border-neutral-600 dark:text-neutral-100"
									/>
									{a.label}
								</label>
							{/each}
						</div>
						{#if data.affiliations.hasOther}
							<div>
								<label
									for="f-otherAffiliations"
									class="mb-1 block text-sm font-medium text-gray-900 dark:text-neutral-100"
									>Other</label
								>
								<input
									id="f-otherAffiliations"
									name="otherAffiliations"
									value={choices.other}
									oninput={() => (affError = '')}
									class="w-full rounded-md border-gray-300 bg-white text-sm text-black dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100"
								/>
							</div>
						{/if}
						{#if affError}
							<p class="text-sm text-red-600 dark:text-red-400">{affError}</p>
						{/if}
					</div>
				</div>
			{/if}

			<!-- Private card — visually disconnected, darker grey. -->
			{#if privateFields.length}
				<div
					class="rounded-xl border border-gray-300 bg-gray-100 shadow-sm dark:border-white/10 dark:bg-neutral-800"
				>
					<div class="border-b border-gray-200 px-6 py-5 dark:border-white/10">
						<h2 class="text-xl font-bold">Private</h2>
						<p class="text-sm text-gray-500 dark:text-neutral-400">
							All fields below are private and only visible to admins, and will be used only if
							absolutely necessary.
						</p>
					</div>
					<div class="divide-y divide-gray-200 dark:divide-white/10">
						{#each privateFields as f (f.name)}
							<div class="grid grid-cols-1 gap-1 px-6 py-4 sm:grid-cols-3 sm:items-start sm:gap-4">
								<label
									for={`f-${f.name}`}
									class="text-sm font-medium text-gray-900 dark:text-neutral-100 sm:pt-2"
								>
									{f.label}{#if f.required}
										<span class="text-gray-400 dark:text-neutral-500">*</span>{/if}
								</label>
								<div class="sm:col-span-2">
									{@render fieldControl(f)}
								</div>
							</div>
						{/each}
					</div>
				</div>
			{/if}

			{#if saveError}
				<p class="text-sm text-red-600 dark:text-red-400">{saveError}</p>
			{/if}

			<div class="flex items-center justify-between gap-3">
				<span class="text-xs italic text-gray-400 dark:text-neutral-500">*Required fields</span>
				<div class="flex items-center gap-3">
					<a
						href={profileHref}
						class="text-sm text-gray-500 transition hover:text-black dark:text-neutral-400 dark:hover:text-neutral-100"
					>
						{data.welcome ? 'Skip for now' : 'Cancel'}
					</a>
					<button
						type="submit"
						disabled={saving}
						class="inline-flex items-center gap-1.5 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
					>
						{#if saving}<Spinner />{/if}
						{saving ? saveMsg : 'Save changes'}
					</button>
				</div>
			</div>
		</form>

		{#if data.emailChange}
			<div class="mt-8">
				<EmailChange
					emailChange={data.emailChange}
					endpoint={`${profileHref}/email`}
					returnTo={$page.url.pathname}
				/>
			</div>
		{/if}
		{#if data.retiredUsernames?.length}
			<!-- Admin only. A retired name redirects to this member and nobody else can
			     claim it until released here. -->
			<div
				class="mt-8 rounded-xl border border-gray-200 bg-white px-6 py-5 shadow-sm dark:border-white/10 dark:bg-neutral-900"
			>
				<h2 class="text-sm font-bold">Retired usernames</h2>
				<p class="text-sm text-gray-500 dark:text-neutral-400">
					Names this member gave up. Each still redirects to their profile and no one else can take
					it. Releasing one ends the redirect and lets any member claim it.
				</p>
				<ul class="mt-3 space-y-2">
					{#each data.retiredUsernames as name (name)}
						<li class="flex items-center justify-between gap-3 text-sm">
							<span class="font-mono">{name}</span>
							<form method="POST" action="?/releaseUsername" use:enhance>
								<input type="hidden" name="username" value={name} />
								<button
									type="submit"
									class="rounded-md border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 transition hover:bg-gray-50 dark:border-neutral-600 dark:text-neutral-300 dark:hover:bg-white/5"
								>
									Release
								</button>
							</form>
						</li>
					{/each}
				</ul>
			</div>
		{/if}
		{#if released || releaseError}
			<p
				aria-live="polite"
				class="mt-2 text-sm {releaseError
					? 'text-red-600 dark:text-red-400'
					: 'text-gray-500 dark:text-neutral-400'}"
			>
				{releaseError || `Released ${released}.`}
			</p>
		{/if}

		{#if data.passkeys}
			<div class="mt-8">
				<Passkeys
					passkeys={data.passkeys}
					endpoint={`${profileHref}/passkeys`}
					returnTo={$page.url.pathname}
				/>
			</div>
		{/if}

		<br />
		<br />

		<!-- Danger zone — separate form (a delete can't nest in the edit form). Deletes
		     the member's sheet + DB rows, revokes their sessions, and signs them out. -->
		{#if data.canDelete}
			<div
				class="mt-[100px] flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50/40 px-6 py-5 dark:border-red-900/40 dark:bg-red-950/30 sm:flex-row sm:items-center sm:justify-between"
			>
				<div>
					<h2 class="text-sm font-bold text-red-700 dark:text-red-300">Delete profile</h2>
					<p class="text-sm text-gray-500 dark:text-neutral-400">
						Permanently removes your directory listing and signs you out. This can't be undone.
					</p>
				</div>
				<form method="POST" action="?/delete" use:enhance={enhanceDelete} class="shrink-0">
					<button
						type="submit"
						class="rounded-md border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-600 transition hover:bg-red-50 dark:border-red-900/40 dark:bg-neutral-900 dark:text-red-400 dark:hover:bg-red-950/30"
					>
						Delete profile
					</button>
				</form>
			</div>
			{#if deleteError}
				<p class="mt-2 text-sm text-red-600 dark:text-red-400">{deleteError}</p>
			{/if}
		{/if}
	{/if}
</section>
