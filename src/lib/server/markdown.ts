import MarkdownIt from 'markdown-it';

// Renders per-group landing Markdown to HTML at request time (mdsvex is
// build-time only and can't do self-serve tenants). `html: false` means raw
// HTML in the source is escaped, not passed through — that removes the
// script/onclick XSS vector even though landing copy is admin-authored.
// `linkify` auto-links bare URLs; `typographer` does smart quotes/dashes.
const md = new MarkdownIt({
	html: false,
	linkify: true,
	typographer: true,
	breaks: false
});

export type RenderOptions = {
	// Shifts every heading down by this many levels (1 turns `#` into `<h2>`).
	// The landing page owns its `<h1>` in the template, so admin copy that opens
	// with `# Title` would otherwise give the page a second one.
	headingOffset?: number;
};

export function renderMarkdown(
	source: string | null | undefined,
	{ headingOffset = 0 }: RenderOptions = {}
): string {
	if (!source || !source.trim()) return '';
	if (!headingOffset) return md.render(source);

	const tokens = md.parse(source, {});
	for (const t of tokens) {
		if (t.type !== 'heading_open' && t.type !== 'heading_close') continue;
		// `h6` is the floor: past it the tag stops being a heading at all, and a
		// demoted `<h7>` renders as an unstyled inline element.
		t.tag = `h${Math.min(6, Number(t.tag.slice(1)) + headingOffset)}`;
	}
	return md.renderer.render(tokens, md.options, {});
}
