// State and keyboard handling for Combobox.svelte, kept out of the component so
// the suite (plain `node --test`, no DOM) can drive it key by key. The component
// renders this state and forwards every keydown here; nothing else moves it.
// Keys follow the WAI-ARIA 1.2 combobox pattern with list autocomplete.

/** Lowercase, NFKD, combining marks dropped: `Côte` and `cote` compare equal. */
export function fold(s: string): string {
	return s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
}

/** True when `query` starts a word of `text`, both folded. */
export function startsWord(text: string, query: string): boolean {
	const t = fold(text);
	const q = fold(query).trim();
	if (!q) return true;
	for (let at = t.indexOf(q); at !== -1; at = t.indexOf(q, at + 1)) {
		if (at === 0 || !/[\p{L}\p{N}]/u.test(t[at - 1])) return true;
	}
	return false;
}

export type Matcher = (option: string, query: string) => boolean;

export interface ComboState {
	/** The committed value: what the hidden input posts. */
	value: string;
	/** What the text box shows. */
	text: string;
	/** The query the list is filtered by; empty shows every option. */
	filter: string;
	open: boolean;
	/** Index into the filtered list, or -1 for none. */
	active: number;
}

export const comboInit = (value: string): ComboState => ({
	value,
	text: value,
	filter: '',
	open: false,
	active: -1
});

export const comboFiltered = (options: string[], s: ComboState, match: Matcher = startsWord) =>
	s.filter.trim() ? options.filter((o) => match(o, s.filter)) : options;

/** The member typed: filter on it and point at the first hit. */
export function comboType(
	s: ComboState,
	text: string,
	options: string[],
	match?: Matcher
): ComboState {
	const next = { ...s, text, filter: text, open: true };
	return { ...next, active: comboFiltered(options, next, match).length ? 0 : -1 };
}

/** Pick `option`, close, and show it in the text box. */
export const comboPick = (s: ComboState, option: string): ComboState => ({
	...s,
	value: option,
	text: option,
	filter: '',
	open: false,
	active: -1
});

/**
 * Leave without picking. A cleared text box clears the value, which is how an
 * optional field is emptied; anything else typed reverts to the committed value,
 * so a half-typed query never posts.
 */
export const comboDismiss = (s: ComboState): ComboState =>
	s.text.trim() === ''
		? { ...s, value: '', text: '', filter: '', open: false, active: -1 }
		: { ...s, text: s.value, filter: '', open: false, active: -1 };

/** Open on the full list with the committed value active, if it is in it. */
function openAll(s: ComboState, options: string[], fallback: number): ComboState {
	const at = options.indexOf(s.value);
	return { ...s, filter: '', open: true, active: at !== -1 ? at : fallback };
}

/**
 * One keydown. Returns the next state, or null when the key is not the
 * combobox's to handle and the browser's default should run: Enter on a closed
 * list submits the form, Home and End on a closed list move the caret.
 */
export function comboKey(
	s: ComboState,
	key: string,
	options: string[],
	match?: Matcher
): ComboState | null {
	const list = comboFiltered(options, s, match);
	const last = list.length - 1;
	switch (key) {
		case 'ArrowDown':
			if (!s.open) return openAll(s, options, 0);
			return { ...s, active: Math.min(s.active + 1, last) };
		case 'ArrowUp':
			if (!s.open) return openAll(s, options, options.length - 1);
			return { ...s, active: Math.max(s.active - 1, Math.min(0, last)) };
		case 'Home':
			return s.open ? { ...s, active: last >= 0 ? 0 : -1 } : null;
		case 'End':
			return s.open ? { ...s, active: last } : null;
		case 'Enter':
			if (!s.open) return null;
			return s.active >= 0 && s.active <= last ? comboPick(s, list[s.active]) : comboDismiss(s);
		case 'Escape':
			return s.open ? comboDismiss(s) : null;
		default:
			return null;
	}
}
