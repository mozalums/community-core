// Lifted from another LoremLabs project. Deterministic
// color picker from a fixed palette: same input string always returns the
// same color. Inline djb2 hash so we don't pull in `string-hash` as a dep.

export const defaultPalette = [
	'#3366CC',
	'#DC3912',
	'#FF9900',
	'#109618',
	'#990099',
	'#3B3EAC',
	'#0099C6',
	'#DD4477',
	'#66AA00',
	'#FF0099',
	'#B82E2E',
	'#316395',
	'#994499',
	'#22AA99',
	'#AACA51',
	'#6633CC',
	'#F67370',
	'#8B0707',
	'#329262',
	'#5574A6'
];

function djb2(s: string): number {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return h >>> 0; // unsigned
}

export function colorizer(name: string, palette: string[] = defaultPalette): string {
	const key = (name || '??').toLowerCase();
	return palette[djb2(key) % palette.length];
}
