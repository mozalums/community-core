<script lang="ts">
	import { page } from '$app/stores';
	import { groupBase } from '$lib/group-nav';
	import type { ActionData, PageData } from './$types';

	const { data, form }: { data: PageData; form: ActionData } = $props();
	const base = $derived(groupBase($page.url.pathname, data.group.slug));

	const preview = $derived(form?.view ? form : null);
	const nothingToDo = $derived(
		preview?.view
			? preview.view.counts.added + preview.view.counts.changed + preview.view.counts.removed === 0
			: false
	);
	let mode = $state<'merge' | 'replace'>('merge');
	$effect(() => {
		if (form?.mode === 'merge' || form?.mode === 'replace') mode = form.mode;
	});
</script>

<svelte:head>
	<title>Import the roster — {data.group.name}</title>
</svelte:head>

<section class="space-y-6">
	<div>
		<h1 class="text-2xl font-bold tracking-tight">Import the roster</h1>
		<p class="mt-1 text-sm text-gray-600 dark:text-neutral-400">
			Edit the directory in a spreadsheet: <a
				class="font-medium text-blue-700 hover:underline dark:text-blue-400"
				href={`${base}/admin`}>export it</a
			>, change it in Excel, Numbers or Google Sheets, save it as CSV and upload it here. Nothing
			changes until you have read the preview and pressed Apply.
		</p>
	</div>

	{#if form?.applied}
		<div
			role="status"
			class="rounded-md bg-green-50 p-3 text-sm text-green-800 dark:bg-green-950/40 dark:text-green-300"
		>
			Imported: {form.applied.added} added, {form.applied.changed} changed, {form.applied.removed}
			removed, {form.applied.unchanged} unchanged. Every change is in the
			<a class="underline" href={`${base}/admin/audit`}>audit trail</a>.
		</div>
	{/if}

	{#if form?.errors?.length}
		<div
			role="alert"
			class="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
		>
			<p class="font-medium">Nothing was imported.</p>
			<ul class="mt-1 list-disc space-y-1 pl-5">
				{#each form.errors as e (e)}<li>{e}</li>{/each}
			</ul>
		</div>
	{/if}

	{#if form?.warnings?.length}
		<div
			class="rounded-md bg-amber-50 p-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300"
		>
			<p class="font-medium">Ignored columns</p>
			<ul class="mt-1 list-disc space-y-1 pl-5">
				{#each form.warnings as w (w)}<li>{w}</li>{/each}
			</ul>
		</div>
	{/if}

	{#if preview?.view}
		{@const v = preview.view}
		<div
			class="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-neutral-900"
		>
			<div>
				<h2 class="text-lg font-semibold">Preview: {preview.fileName}</h2>
				<p class="text-sm text-gray-600 dark:text-neutral-400">
					{#if v.mode === 'merge'}
						Merge: rows in the file are added or updated. Nobody is removed.
					{:else}
						Replace: the file is the whole roster. Active members who are not in it are removed.
					{/if}
					{v.rows} rows read; the directory has {v.active} active members.
				</p>
			</div>

			<dl class="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{#each [['Added', v.counts.added], ['Changed', v.counts.changed], ['Removed', v.counts.removed], ['Unchanged', v.counts.unchanged]] as [label, n] (label)}
					<div class="rounded-lg border border-gray-200 px-4 py-3 dark:border-white/10">
						<dt class="text-xs font-medium uppercase tracking-wide text-gray-500">{label}</dt>
						<dd
							class={'mt-1 text-2xl font-semibold tabular-nums ' +
								(label === 'Removed' && Number(n) > 0 ? 'text-red-700 dark:text-red-400' : '')}
						>
							{n}
						</dd>
					</div>
				{/each}
			</dl>

			{#if v.removed.length}
				<details open class="text-sm">
					<summary class="cursor-pointer font-medium text-red-700 dark:text-red-400">
						Removed ({v.removed.length})
					</summary>
					<ul class="mt-2 space-y-0.5 pl-5">
						{#each v.removed as r (r.email)}
							<li><span class="font-mono">{r.email}</span> · {r.why}</li>
						{/each}
					</ul>
				</details>
			{/if}

			{#if v.changed.length}
				<details open class="text-sm">
					<summary class="cursor-pointer font-medium">Changed ({v.changed.length})</summary>
					<div class="mt-2 space-y-3">
						{#each v.changed as c (c.email)}
							<div>
								<p>
									<span class="font-mono">{c.email}</span>
									<span class="text-gray-500">· {c.at}</span>
									{#if c.inactive}
										<span class="text-amber-700 dark:text-amber-400"
											>· removed member, stays removed</span
										>
									{/if}
								</p>
								<table class="mt-1 w-full table-fixed text-left">
									<thead class="text-xs text-gray-500">
										<tr><th class="w-1/4">Field</th><th>Now</th><th>After import</th></tr>
									</thead>
									<tbody>
										{#each c.fields as f (f.label)}
											<tr class="align-top">
												<td class="pr-2">{f.label}</td>
												<td class="whitespace-pre-wrap break-words pr-2 text-gray-500"
													>{f.before || '(empty)'}</td
												>
												<td class="whitespace-pre-wrap break-words"
													>{#if f.after}{f.after}{:else}<em>(cleared)</em>{/if}</td
												>
											</tr>
										{/each}
									</tbody>
								</table>
							</div>
						{/each}
					</div>
				</details>
			{/if}

			{#if v.added.length}
				<details open class="text-sm">
					<summary class="cursor-pointer font-medium">Added ({v.added.length})</summary>
					<ul class="mt-2 space-y-1 pl-5">
						{#each v.added as a (a.email)}
							<li>
								<span class="font-mono">{a.email}</span>
								<span class="text-gray-500">· {a.at}</span>
								{#if a.fields.length}
									<span class="text-gray-600 dark:text-neutral-400">
										· {a.fields.map((f) => `${f.label}: ${f.value}`).join('; ')}
									</span>
								{/if}
							</li>
						{/each}
					</ul>
				</details>
			{/if}

			{#if preview.gate?.kind === 'refused'}
				<p
					role="alert"
					class="rounded-md bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300"
				>
					{preview.gate.message}
				</p>
			{:else if nothingToDo}
				<p class="text-sm text-gray-600 dark:text-neutral-400">
					The file matches the directory. There is nothing to apply.
				</p>
			{:else if preview.planId}
				<form method="POST" action="?/apply" class="space-y-3 border-t pt-4 dark:border-white/10">
					<input type="hidden" name="plan" value={preview.planId} />
					<input type="hidden" name="digest" value={preview.digest} />
					{#if preview.gate?.kind === 'typed'}
						<label class="block text-sm">
							<span class="font-medium text-red-700 dark:text-red-400">
								This removes {preview.gate.count} members. Type {preview.gate.count} to confirm.
							</span>
							<input
								name="confirm"
								inputmode="numeric"
								autocomplete="off"
								required
								class="mt-1 block w-32 rounded-md border-gray-300 text-sm dark:border-white/10 dark:bg-neutral-800"
							/>
						</label>
					{/if}
					<p class="text-sm text-gray-600 dark:text-neutral-400">
						Apply makes exactly the changes listed above. If the directory changes before you press
						it, nothing is applied and you will be asked to upload again.
					</p>
					<button
						class="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
						>Apply these changes</button
					>
				</form>
			{/if}
		</div>
	{/if}

	<div
		class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-white/10 dark:bg-neutral-900"
	>
		<h2 class="text-sm font-semibold">How the file is read</h2>
		<ul class="mt-2 list-disc space-y-1.5 pl-5 text-sm text-gray-700 dark:text-neutral-300">
			<li>
				Each row is matched to a member by its <strong>{data.loginLabel}</strong> column, ignoring
				capital letters. Every row needs one. If any row's {data.loginLabel} is blank, not an address,
				or appears twice, nothing is imported and those rows are listed.
			</li>
			<li>
				<strong>A column you leave out of the file is left alone.</strong> A file with only
				{data.loginLabel} and City changes cities and nothing else.
			</li>
			<li>
				<strong>An empty cell clears that field</strong> for that member. Taking a column out of the file
				never deletes the field.
			</li>
			<li>
				Column headings are the field names an export uses; capitals and spaces around them do not
				matter. A heading that is not a field is listed as a warning and its values are not saved.
			</li>
			<li>
				Comma-, semicolon- and tab-separated files all work, and so do Excel's "CSV UTF-8" and
				"Unicode Text". Up to {data.maxMb} MB and {data.maxRows} rows.
			</li>
		</ul>
		<details class="mt-2 text-sm text-gray-600 dark:text-neutral-400">
			<summary class="cursor-pointer">The field names</summary>
			<p class="mt-1">{data.labels.join(' · ')}</p>
		</details>

		<form method="POST" action="?/preview" enctype="multipart/form-data" class="mt-4 space-y-4">
			<fieldset class="space-y-2 text-sm">
				<legend class="font-medium">What should happen to members who are not in the file?</legend>
				<label class="flex items-start gap-2">
					<input type="radio" name="mode" value="merge" bind:group={mode} class="mt-0.5" />
					<span
						><strong>Merge</strong> (usual): they are left exactly as they are. Rows in the file are added
						or updated, and nobody is removed.</span
					>
				</label>
				<label class="flex items-start gap-2">
					<input type="radio" name="mode" value="replace" bind:group={mode} class="mt-0.5" />
					<span
						><strong>Replace</strong>: the file is the whole roster, so active members who are not
						in it are removed. A Status column can also mark a row removed or active.</span
					>
				</label>
			</fieldset>
			<label class="block text-sm">
				<span class="font-medium">CSV file</span>
				<input
					type="file"
					name="file"
					required
					accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
					class="mt-1 block text-sm"
				/>
			</label>
			<button
				class="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50 dark:border-white/20 dark:hover:bg-white/10"
				>Preview changes</button
			>
		</form>
	</div>
</section>
