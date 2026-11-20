<script lang="ts">
	import { enhance } from '$app/forms';
	import SignOut from '$lib/components/SignOut.svelte';
	import { brand, site } from '$skin/skin.yaml';
	import type { PageData, ActionData } from './$types';

	const { data, form }: { data: PageData; form: ActionData } = $props();
	let saving = $state(false);

	// Repopulate after a failed submit; fall back to the login-name prefill.
	const v = $derived((form as { values?: Record<string, string> } | null)?.values ?? {});
	const checkedSet = $derived(new Set((form as { checked?: string[] } | null)?.checked ?? []));
	const err = $derived((form as { error?: string } | null)?.error ?? '');
	const submitted = $derived((form as { submitted?: boolean } | null)?.submitted ?? false);

	const NAME_LABELS = { name: 'Name', firstName: 'First name', lastName: 'Last name' };
	const nameValue = $derived({
		name: v.name ?? data.prefill.name,
		firstName: v.firstName ?? data.prefill.firstName,
		lastName: v.lastName ?? data.prefill.lastName
	});
	const linkedin = $derived(v.linkedin ?? '');
	const other = $derived(v.otherAffiliations ?? '');
	// Unchecked unless the requester ticked it and the submit came back rejected.
	const publicProfile = $derived(
		(form as { publicProfile?: boolean } | null)?.publicProfile ?? false
	);

	const rowClass = 'grid grid-cols-1 gap-1 px-6 py-4 sm:grid-cols-3 sm:items-start sm:gap-4';
	const inputClass =
		'w-full rounded-md border-gray-300 bg-white text-sm text-black placeholder-gray-400 focus:border-gray-900 focus:ring-gray-900 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-100 dark:placeholder-neutral-500';
</script>

<svelte:head>
	<title>Request membership — {data.group.name}</title>
</svelte:head>

<section class="space-y-6">
	<img src="/{brand.wordmark}" alt={site.name} class="mx-auto h-12 w-auto md:h-14" />

	<div
		class="min-h-[300px] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm dark:border-white/10 dark:bg-neutral-900"
	>
		<div class="border-b border-gray-100 px-6 py-5 dark:border-white/10">
			{#if submitted}
				<h1 class="text-xl font-bold">Membership requested</h1>
			{:else}
				<h1 class="text-xl font-bold">Request membership</h1>
				<p class="text-sm text-gray-500 dark:text-neutral-400">
					Signed in as <span class="font-medium text-gray-700 dark:text-neutral-300"
						>{data.email}</span
					>
					<SignOut
						class="underline underline-offset-2 hover:text-gray-700 dark:hover:text-neutral-300"
						>[sign out]</SignOut
					>. Fill out your details and an admin will review your request.
				</p>
			{/if}
		</div>

		{#if submitted}
			<p class="px-6 py-6 text-sm text-gray-700 dark:text-neutral-300">
				Thanks — your request was received. An admin will review it and you'll get access once
				approved.
			</p>
		{:else}
			<form
				method="POST"
				use:enhance={() => {
					saving = true;
					return async ({ update }) => {
						await update();
						saving = false;
					};
				}}
			>
				<div
					class="divide-y divide-gray-100 border-b border-gray-100 dark:divide-white/10 dark:border-white/10"
				>
					<!-- One whole name, or a given and a family name, in the order the
					     skin lists them. -->
					{#each data.nameControls as c (c.control)}
						<div class={rowClass}>
							<label
								for={`f-${c.control}`}
								class="text-sm font-medium text-gray-900 dark:text-neutral-100 sm:pt-2"
							>
								{NAME_LABELS[c.control]}
								{#if c.required}<span class="text-gray-400 dark:text-neutral-500">*</span>{/if}
							</label>
							<div class="sm:col-span-2">
								<input
									id={`f-${c.control}`}
									name={c.control}
									required={c.required}
									value={nameValue[c.control]}
									class={inputClass}
								/>
							</div>
						</div>
					{/each}

					{#if data.asks.affiliation}
						<!-- Associated with -->
						<div class={rowClass}>
							<div class="text-sm font-medium text-gray-900 dark:text-neutral-100 sm:pt-2">
								Associated with <span class="text-gray-400 dark:text-neutral-500">*</span>
							</div>
							<div class="space-y-3 sm:col-span-2">
								<div class="flex flex-wrap gap-x-5 gap-y-2">
									{#each data.affiliations as a (a.key)}
										<label
											class="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-neutral-300"
										>
											<input
												type="checkbox"
												name={`aff_${a.key}`}
												checked={checkedSet.has(a.key)}
												class="rounded border-gray-300 text-gray-900 focus:ring-gray-900 dark:border-neutral-600 dark:text-neutral-100"
											/>
											{a.label}
										</label>
									{/each}
								</div>
								{#if data.asks.otherAffiliation}
									<div>
										<input
											name="otherAffiliations"
											value={other}
											placeholder={data.otherPlaceholder}
											class={inputClass}
										/>
										<p class="mt-1 text-xs text-gray-400 dark:text-neutral-500">
											Other (comma separated)
										</p>
									</div>
								{/if}
							</div>
						</div>
					{/if}

					{#if data.asks.linkedin}
						<!-- LinkedIn URL -->
						<div class={rowClass}>
							<label
								for="f-linkedin"
								class="text-sm font-medium text-gray-900 dark:text-neutral-100 sm:pt-2"
							>
								LinkedIn URL <span class="text-gray-400 dark:text-neutral-500">*</span>
							</label>
							<div class="sm:col-span-2">
								<input
									id="f-linkedin"
									name="linkedin"
									type="url"
									required
									value={linkedin}
									placeholder="https://www.linkedin.com/in/…"
									class={inputClass}
								/>
							</div>
						</div>
					{/if}

					{#if data.asks.publicProfile}
						<!-- Public profile — the same sentence the edit page shows, so a member
					     meets one wording rather than two. Unticked: registering does not publish. -->
						<div class={rowClass}>
							<div class="text-sm font-medium text-gray-900 dark:text-neutral-100 sm:pt-2">
								Public profile
							</div>
							<div class="sm:col-span-2">
								<label class="flex items-start gap-3 text-sm">
									<input
										type="checkbox"
										name="publicProfile"
										checked={publicProfile}
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
						</div>
					{/if}
				</div>

				{#if err}
					<p class="px-6 pt-4 text-sm text-red-600 dark:text-red-400">{err}</p>
				{/if}

				<div class="flex items-center justify-end gap-4 px-6 py-4">
					<span class="text-xs italic text-gray-400 dark:text-neutral-500">*Required fields</span>
					<button
						type="submit"
						disabled={saving}
						class="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
					>
						{saving ? 'Submitting…' : 'Request membership'}
					</button>
				</div>
			</form>
		{/if}
	</div>
</section>
