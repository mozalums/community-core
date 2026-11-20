// The skin's long copy: Markdown files in its `copy` directory, rendered once
// per process. A file the skin leaves out renders as '', and the page that
// would show it shows nothing in its place (or answers 404, for a document).
//
// Read from SKIN_DIR on disk rather than compiled in: the image carries the
// skin directory, and boot refuses one whose skin.yaml differs from the build.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { currentSkin } from '../skin/load';
import { renderMarkdown } from './markdown';

// Every copy file core reads, by name without the `.md`. docs/skin.md lists
// where each one appears.
export const COPY_NAMES = [
	'landing-hero',
	'landing-band',
	'sidebar',
	'affiliations-help',
	'manifesto',
	'code-of-conduct'
] as const;
export type CopyName = (typeof COPY_NAMES)[number];

const rendered = new Map<string, string>();

function read(file: string): string {
	try {
		return readFileSync(file, 'utf8');
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
		throw e;
	}
}

/** The copy file rendered to HTML, or '' when the skin has none or it is blank. */
export function skinCopy(name: CopyName, dir: string = currentSkin().dir): string {
	const file = join(dir, 'copy', `${name}.md`);
	let html = rendered.get(file);
	if (html === undefined) {
		html = renderMarkdown(read(file));
		rendered.set(file, html);
	}
	return html;
}

/** Whether the skin ships the document, which decides its route and its link. */
export function hasSkinCopy(name: CopyName, dir?: string): boolean {
	return skinCopy(name, dir) !== '';
}
