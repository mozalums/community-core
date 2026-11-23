// Mounts the landing page's sign-in modal in Chromium with a virtual
// authenticator holding a passkey for the page's origin, and signs in with it.
// /auth/passkey is stubbed, so what is proven is the browser half: the modal
// offers a passkey, runs a real WebAuthn ceremony against the server's
// challenge and posts the assertion. The server half is passkey-store's tests.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import path from 'node:path';
import { build } from 'vite';
import { compile } from 'svelte/compiler';
import { launchChromium } from '../../../scripts/chromium';
import { loadSkinDir, skinDir, skinModuleSource } from '../skin/load';

const component = path.join(import.meta.dirname, 'LoginModal.svelte');
const skin = loadSkinDir(skinDir());
assert.notEqual(skin.skin.auth?.passkeys, false, 'the test skin turns passkeys off');

const bundle = await build({
	configFile: false,
	logLevel: 'silent',
	plugins: [
		{
			name: 'login-modal-harness',
			resolveId: (id: string) =>
				id === 'entry' ? id : id === '$skin/skin.yaml' ? '\0skin' : undefined,
			load(id: string) {
				if (id === 'entry')
					return `import { mount, flushSync } from 'svelte';
import LoginModal from ${JSON.stringify(component)};
mount(LoginModal, { target: document.body, props: { open: true, callbackUrl: '/group/g/members' } });
flushSync();`;
				if (id === '\0skin') return skinModuleSource(skin);
			},
			transform(code: string, id: string) {
				if (id.endsWith('.svelte'))
					return compile(code, { filename: id, generate: 'client' }).js.code;
			}
		}
	],
	build: {
		write: false,
		minify: false,
		rollupOptions: { input: 'entry', output: { format: 'iife', name: 'Harness' } }
	}
});
const script = (bundle as { output: { type: string; code: string }[] }).output.find(
	(x) => x.type === 'chunk'
)!.code;

const browser = await launchChromium();
after(() => browser.close());

const b64url = (b: Buffer) => b.toString('base64url');

type Verified = {
	response: { id: string; response: { clientDataJSON: string } };
	callbackUrl: string;
};

// http://localhost is a secure context, so WebAuthn runs on it.
const origin = 'http://localhost';

// A page holding the modal, a browser holding one passkey for its origin, and
// the assertions the modal posts. `autofill: false` is a browser that cannot
// offer passkeys in a field's autofill, where the button is the only way in.
async function signInPage(autofill: boolean) {
	const page = await browser.newPage();
	const challenge = b64url(randomBytes(32));
	const credentialId = randomBytes(16);
	const verified: Verified[] = [];

	if (!autofill)
		await page.addInitScript(() => {
			PublicKeyCredential.isConditionalMediationAvailable = async () => false;
		});
	await page.route(`${origin}/**`, async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === '/auth/passkey') {
			const body = route.request().postDataJSON();
			if (body.step === 'options')
				return route.fulfill({
					json: {
						challenge,
						rpId: 'localhost',
						allowCredentials: [],
						userVerification: 'preferred',
						timeout: 60000
					}
				});
			verified.push(body);
			return route.fulfill({ json: { redirect: '/group/g/members' } });
		}
		if (url.pathname === '/group/g/members')
			return route.fulfill({ contentType: 'text/html', body: '<p>directory</p>' });
		return route.fulfill({
			contentType: 'text/html',
			body: `<!doctype html><body><script>${script.replaceAll('</script', '<\\/script')}</script></body>`
		});
	});

	const cdp = await page.context().newCDPSession(page);
	await cdp.send('WebAuthn.enable', { enableUI: false });
	const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
		options: {
			protocol: 'ctap2',
			transport: 'internal',
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true
		}
	});
	const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
	await cdp.send('WebAuthn.addCredential', {
		authenticatorId,
		credential: {
			credentialId: credentialId.toString('base64'),
			isResidentCredential: true,
			rpId: 'localhost',
			privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
			userHandle: randomBytes(16).toString('base64'),
			signCount: 0
		}
	});
	return { page, challenge, credentialId, verified };
}

function assertSignedIn({
	challenge,
	credentialId,
	verified
}: Awaited<ReturnType<typeof signInPage>>) {
	assert.equal(verified.length, 1, 'the modal posted no assertion');
	const [{ response, callbackUrl }] = verified;
	assert.equal(response.id, b64url(credentialId), 'the assertion is not from the passkey');
	const client = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString());
	assert.equal(client.type, 'webauthn.get');
	assert.equal(client.challenge, challenge, 'the assertion signs another challenge');
	assert.equal(client.origin, origin);
	assert.equal(callbackUrl, '/group/g/members');
}

// The virtual authenticator picks the passkey the moment the browser offers
// it, standing in for a member choosing it from the email field's autofill.
test('the sign-in modal offers a passkey in the email autofill and signs in with it', async () => {
	const s = await signInPage(true);
	await s.page.goto(`${origin}/`);
	await s.page.waitForURL(`${origin}/group/g/members`, { timeout: 10000 });
	assertSignedIn(s);
	await s.page.close();
});

test('the sign-in modal signs in with a passkey from its button', async () => {
	const s = await signInPage(false);
	await s.page.goto(`${origin}/`);
	assert.equal(
		await s.page.getAttribute('#login-modal-email', 'autocomplete'),
		'username webauthn',
		'the email field does not offer passkeys'
	);
	assert.equal(s.verified.length, 0, 'the modal signed in before the button was pressed');
	await s.page.getByRole('button', { name: 'Sign in with a passkey' }).click({ timeout: 5000 });
	await s.page.waitForURL(`${origin}/group/g/members`, { timeout: 10000 });
	assertSignedIn(s);
	await s.page.close();
});
