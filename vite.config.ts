import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import { skinPlugin } from './src/lib/skin/load';

// Ports come from this project's reserved band (see "Ports" in docs/configuration.md). Both
// are strict so a collision fails loudly here instead of drifting onto whatever
// the next port up belongs to. Dev and preview differ deliberately: preview
// shares 5880 with the production container, dev does not, so both can run.
export default defineConfig({
	plugins: [skinPlugin(), sveltekit()],
	server: {
		port: 5870,
		strictPort: true
	},
	preview: {
		port: 5880,
		strictPort: true
	}
});
