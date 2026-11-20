// ESM config: import the plugins instead of `require()`-ing them. The
// previous `plugins: [require('@tailwindcss/forms'), require('@tailwindcss/typography')]`
// silently failed because `require` isn't defined inside an `export default`
// module — Tailwind would fall through with no plugins registered, which
// is why `prose` styling never appeared on /legal/*.

import forms from '@tailwindcss/forms';
import typography from '@tailwindcss/typography';

/** @type {import('tailwindcss').Config} */
export default {
	// Class-based dark mode so a manual toggle can override the OS preference.
	// The default (system) is applied by a no-FOUC inline script in app.html that
	// adds `.dark` when localStorage says dark, or when unset and the OS prefers
	// dark — so `dark:` variants respond to both the system setting and the toggle.
	darkMode: 'class',
	content: ['./src/**/*.{html,js,svelte,ts}'],
	theme: {
		extend: {
			// Bound to the custom properties the skin's theme.css sets, per mode
			// under `.dark`, so a class names a role and the skin picks the color.
			// No `/50` opacity modifier: Tailwind 3 cannot split a var() into
			// channels, so `bg-accent/50` generates no rule at all.
			colors: {
				accent: {
					DEFAULT: 'var(--color-accent)',
					contrast: 'var(--color-accent-contrast)'
				},
				link: 'var(--color-link)'
			},
			fontFamily: {
				// Opt-in only via `font-serif`; the app default stays `sans`.
				serif: 'var(--font-serif)',
				sans: 'var(--font-sans)'
			}
		}
	},
	plugins: [forms, typography]
};
