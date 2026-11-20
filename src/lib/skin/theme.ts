// A skin's theme.css: the colors and type the pages, the page head and the
// mail read. Core defines what the file may hold, and refuses anything else,
// so a skin restyles through named properties and never through selectors of
// its own.
//
// Colors are hex because two readers cannot use a custom property: mail
// clients, which get the value inlined, and the contrast check below.

import postcss, { CssSyntaxError, type Declaration } from 'postcss';
import { SkinError, type SkinIssue } from './schema';

export const COLOR_PROPERTIES = {
	accent: '--color-accent',
	accentContrast: '--color-accent-contrast',
	link: '--color-link'
} as const;

export const FONT_PROPERTIES = ['--font-sans', '--font-serif'] as const;

export type ThemeColors = { [K in keyof typeof COLOR_PROPERTIES]: string };
export type Theme = { light: ThemeColors; dark: ThemeColors };
type Mode = keyof Theme;

// What the platform paints behind content, by mode: the ends of the shell's
// gradient and the card surface. A skin picks its colors; this list is core's,
// so a skin cannot pass the floor by naming a friendlier background.
export const PAGE_BACKGROUNDS: Record<Mode, readonly string[]> = {
	light: ['#f3f4f6', '#f9fafb', '#ffffff'],
	dark: ['#0a0a0a', '#171717', '#000000']
};

// WCAG 2 AA for body text.
export const CONTRAST_FLOOR = 4.5;

const BLOCKS: Record<string, { mode: Mode; allowed: readonly string[] }> = {
	':root': {
		mode: 'light',
		allowed: [...Object.values(COLOR_PROPERTIES), ...FONT_PROPERTIES]
	},
	'.dark': { mode: 'dark', allowed: Object.values(COLOR_PROPERTIES) }
};
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

function luminance(hex: string): number {
	const channel = (i: number) => {
		const c = parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16) / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

// The WCAG 2 contrast ratio of two six-digit hex colors, 1 to 21.
export function contrastRatio(a: string, b: string): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

function sixDigit(hex: string): string {
	const h = hex.toLowerCase();
	return h.length === 4 ? `#${[...h.slice(1)].map((c) => c + c).join('')}` : h;
}

function floorIssues(theme: Theme): SkinIssue[] {
	const issues: SkinIssue[] = [];
	for (const [selector, { mode }] of Object.entries(BLOCKS)) {
		const c = theme[mode];
		const pairs: [keyof ThemeColors, string, string][] = [
			['accent', c.accentContrast, COLOR_PROPERTIES.accentContrast],
			...PAGE_BACKGROUNDS[mode].map((bg): [keyof ThemeColors, string, string] => [
				'accent',
				bg,
				`the ${mode} page ${bg}`
			]),
			...PAGE_BACKGROUNDS[mode].map((bg): [keyof ThemeColors, string, string] => [
				'link',
				bg,
				`the ${mode} page ${bg}`
			])
		];
		for (const [key, against, label] of pairs) {
			const ratio = contrastRatio(c[key], against);
			if (ratio >= CONTRAST_FLOOR) continue;
			issues.push({
				path: `${selector} ${COLOR_PROPERTIES[key]}`,
				found: `${c[key]}, ${ratio.toFixed(2)}:1 against ${label}`,
				expected: `at least ${CONTRAST_FLOOR}:1`
			});
		}
	}
	return issues;
}

// Reads theme.css, or throws a SkinError naming every problem: a selector or
// at-rule core does not read, an unknown or missing property, a color that is
// not hex, and a pair under the contrast floor.
export function readTheme(css: string, file: string): Theme {
	let root;
	try {
		root = postcss.parse(css, { from: file });
	} catch (e) {
		const reason = e instanceof CssSyntaxError ? e.reason : (e as Error).message;
		throw new SkinError(file, [{ path: '', found: `invalid CSS (${reason})`, expected: 'CSS' }]);
	}
	const issues: SkinIssue[] = [];
	const found: Record<string, Map<string, string>> = {};
	for (const node of root.nodes) {
		if (node.type === 'comment') continue;
		if (node.type === 'atrule' && node.name === 'font-face') continue;
		const block = node.type === 'rule' ? BLOCKS[node.selector] : undefined;
		if (node.type !== 'rule' || !block) {
			issues.push({
				path: node.type === 'rule' ? node.selector : node.type === 'atrule' ? `@${node.name}` : '',
				found:
					node.type === 'rule'
						? 'a selector core does not read'
						: node.type === 'atrule'
							? 'an at-rule core does not read'
							: `a ${node.type}`,
				expected: `${Object.keys(BLOCKS).join(', ')} or @font-face`
			});
			continue;
		}
		const decls = (found[node.selector] ??= new Map());
		for (const child of node.nodes) {
			if (child.type === 'comment') continue;
			const prop = child.type === 'decl' ? (child as Declaration).prop : '';
			const at = `${node.selector} ${prop || child.type}`;
			if (child.type !== 'decl' || !block.allowed.includes(prop)) {
				issues.push({
					path: at,
					found: child.type === 'decl' ? 'an unknown property' : `a nested ${child.type}`,
					expected: `one of ${block.allowed.join(', ')}`
				});
			} else if (decls.has(prop)) {
				issues.push({ path: at, found: 'a second value', expected: 'one value' });
			} else {
				decls.set(prop, child.value.trim());
			}
		}
	}
	for (const [selector, { allowed }] of Object.entries(BLOCKS)) {
		const decls = found[selector] ?? new Map<string, string>();
		for (const prop of allowed) {
			const value = decls.get(prop);
			const at = `${selector} ${prop}`;
			if (value === undefined || value === '') {
				issues.push({ path: at, found: 'nothing', expected: 'a value (required)' });
			} else if (prop.startsWith('--color-') && !HEX.test(value)) {
				issues.push({ path: at, found: `"${value}"`, expected: 'a hex color, #rgb or #rrggbb' });
			}
		}
	}
	if (issues.length) throw new SkinError(file, issues);
	const colors = (selector: string): ThemeColors => {
		const decls = found[selector];
		const get = (key: keyof ThemeColors) => sixDigit(decls.get(COLOR_PROPERTIES[key])!);
		return { accent: get('accent'), accentContrast: get('accentContrast'), link: get('link') };
	};
	const theme: Theme = { light: colors(':root'), dark: colors('.dark') };
	const floor = floorIssues(theme);
	if (floor.length) throw new SkinError(file, floor);
	return theme;
}
