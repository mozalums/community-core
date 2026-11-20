// `$skin` resolves to SKIN_DIR. skin.yaml is not TypeScript, so its two import
// forms are declared here: `skinPlugin` (src/lib/skin/load.ts) serves the
// validated file as one named export per top-level key plus `theme`, the colors
// read from theme.css, and `?raw` is the text.

declare module '$skin/skin.yaml' {
	type Skin = import('$lib/skin/schema').Skin;
	export const schema: Skin['schema'];
	export const id: Skin['id'];
	export const site: Skin['site'];
	export const mail: Skin['mail'];
	export const brand: Skin['brand'];
	export const analytics: Skin['analytics'];
	export const fields: Skin['fields'];
	export const theme: import('$lib/skin/theme').Theme;
}

declare module '$skin/skin.yaml?raw' {
	const text: string;
	export default text;
}
