// State and keys for the links field's site picker (LinksField.svelte), a
// select-only combobox in the WAI-ARIA 1.2 pattern: a focusable box naming the
// chosen site and a listbox of the rest. Kept out of the component so the
// suite can drive it key by key without a DOM. A native <select> cannot show
// an icon beside each option, which is the reason this exists at all.

import type { SiteDef } from '../links';

export type PickerState = {
	open: boolean;
	// Index into the options, or -1 for none.
	active: number;
};

export const pickerInit = (): PickerState => ({ open: false, active: -1 });

// The sites one row may pick: every offered site no other row holds, so two
// rows can never name the same site. The row's own site stays in its list.
export function sitesForRow(
	sites: readonly SiteDef[],
	chosen: readonly string[],
	row: number
): SiteDef[] {
	const taken = new Set(chosen.filter((id, i) => i !== row && id));
	return sites.filter((s) => !taken.has(s.id));
}

export type PickerResult = { state: PickerState; pick?: number } | null;

/**
 * One keydown on the picker box. `current` is the index of the row's site in
 * `labels`, -1 for none. Returns null when the key is not the picker's, so the
 * browser's default runs (Tab moves on, Enter on a closed box submits).
 */
export function pickerKey(
	s: PickerState,
	key: string,
	labels: readonly string[],
	current: number
): PickerResult {
	const last = labels.length - 1;
	const openAt = (i: number): PickerResult => ({ state: { open: true, active: i } });
	if (!s.open) {
		switch (key) {
			case 'ArrowDown':
			case 'Enter':
			case ' ':
				return openAt(current >= 0 ? current : 0);
			case 'ArrowUp':
				return openAt(current >= 0 ? current : last);
			case 'Home':
				return openAt(0);
			case 'End':
				return openAt(last);
		}
		return typeAhead(s, key, labels, current, true);
	}
	switch (key) {
		case 'ArrowDown':
			return { state: { ...s, active: Math.min(s.active + 1, last) } };
		case 'ArrowUp':
			return { state: { ...s, active: Math.max(s.active - 1, 0) } };
		case 'Home':
			return { state: { ...s, active: 0 } };
		case 'End':
			return { state: { ...s, active: last } };
		case 'Enter':
		case ' ':
			return { state: pickerInit(), ...(s.active >= 0 ? { pick: s.active } : {}) };
		case 'Tab':
			// Leaves the box as well: the active site is taken, and the key is
			// still the browser's to move focus.
			return s.active >= 0 ? { state: pickerInit(), pick: s.active } : { state: pickerInit() };
		case 'Escape':
			return { state: pickerInit() };
	}
	return typeAhead(s, key, labels, s.active, false);
}

// A printable key moves to the next site whose label starts with it.
function typeAhead(
	s: PickerState,
	key: string,
	labels: readonly string[],
	from: number,
	opening: boolean
): PickerResult {
	if (key.length !== 1 || !/\S/.test(key)) return null;
	const k = key.toLowerCase();
	for (let step = 1; step <= labels.length; step++) {
		const i = (Math.max(from, -1) + step) % labels.length;
		if (labels[i].toLowerCase().startsWith(k)) return { state: { ...s, open: true, active: i } };
	}
	return opening ? null : { state: s };
}
