// A bio is free text a member controls and every member reads. It is not
// Markdown: the only thing it may turn into is a link, and only to `https:`.
// Everything else comes back as text for the page to escape.

export type BioSegment =
	| { kind: 'text'; text: string }
	| { kind: 'link'; text: string; href: string };

const STOP = /[\s<>"]/;
const TRAILING = new Set(['.', ',', ';', ':', '!', '?', "'"]);
const CLOSERS: Record<string, string> = { ')': '(', ']': '[' };

// Drop sentence punctuation the writer put after the URL, and a closing
// bracket only when the URL holds no partner for it, so "(see https://a.org/x)"
// stops before ")" while "https://en.wikipedia.org/wiki/Foo_(bar)" keeps it.
function trimTail(candidate: string): string {
	const tally: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0 };
	for (const ch of candidate) if (ch in tally) tally[ch] += 1;
	let end = candidate.length;
	for (;;) {
		const last = candidate[end - 1] ?? '';
		const opener = CLOSERS[last];
		if (TRAILING.has(last)) end -= 1;
		else if (opener && tally[opener] < tally[last]) {
			tally[last] -= 1;
			end -= 1;
		} else return candidate.slice(0, end);
	}
}

function safeHref(written: string): string | null {
	let url: URL;
	try {
		url = new URL(written);
	} catch {
		return null;
	}
	if (url.protocol !== 'https:' || !url.hostname.includes('.')) return null;
	return url.href;
}

export function splitBioLinks(bio: string): BioSegment[] {
	const out: BioSegment[] = [];
	const pushText = (text: string) => {
		if (!text) return;
		const prev = out.at(-1);
		if (prev?.kind === 'text') prev.text += text;
		else out.push({ kind: 'text', text });
	};

	const scheme = /https:\/\//gi;
	let cursor = 0;
	for (let m = scheme.exec(bio); m; m = scheme.exec(bio)) {
		const start = m.index;
		let end = start + m[0].length;
		while (end < bio.length && !STOP.test(bio[end])) end += 1;
		const written = trimTail(bio.slice(start, end));
		const href = written.length > m[0].length ? safeHref(written) : null;
		if (!href) {
			// The whole candidate stays text; rescanning inside it would both
			// promote an https:// substring of a rejected URL and go quadratic.
			scheme.lastIndex = end;
			continue;
		}
		pushText(bio.slice(cursor, start));
		out.push({ kind: 'link', text: written, href });
		cursor = start + written.length;
		scheme.lastIndex = cursor;
	}
	pushText(bio.slice(cursor));
	return out;
}
