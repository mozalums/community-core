import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { buildMessage, dotStuff, sendSmtpMail, smtpConfig, tlsOptions } from './smtp';
import type { MailMessage } from './mail';

const CREDS = {
	SMTP_HOST: 'mail.example.org',
	SMTP_USER: 'no-reply@example.org',
	SMTP_PASSWORD: 'pw'
};

const IDENTITY = {
	from: 'no-reply@example.org',
	messageId: '<abc@example.org>',
	date: 'Tue, 11 Aug 2026 12:00:00 +0000',
	boundary: '=_deadbeef'
};

function message(over: Partial<MailMessage> = {}): MailMessage {
	return {
		fromName: 'Example Community',
		to: ['member@example.com'],
		subject: 'Sign in',
		text: 'hello',
		tag: 'login',
		...over
	};
}

test('port 25 is refused: it is relay, not authenticated submission', () => {
	assert.throws(() => smtpConfig({ ...CREDS, SMTP_PORT: '25' }), /relay, not submission/);
});

test('credentials are mandatory — there is no unauthenticated path', () => {
	assert.throws(() => smtpConfig({ SMTP_HOST: 'mail.example.org' }), /SMTP_USER and SMTP_PASSWORD/);
	assert.throws(() => smtpConfig({ ...CREDS, SMTP_PASSWORD: undefined }), /SMTP_USER and SMTP_P/);
	assert.throws(() => smtpConfig({ SMTP_USER: 'u', SMTP_PASSWORD: 'p' }), /SMTP_HOST is unset/);
});

test('the port defaults to 587 and selects implicit TLS only on 465', () => {
	assert.equal(smtpConfig(CREDS).port, 587);
	assert.equal(smtpConfig(CREDS).implicitTls, false);
	assert.equal(smtpConfig({ ...CREDS, SMTP_PORT: '465' }).implicitTls, true);
	assert.equal(smtpConfig({ ...CREDS, SMTP_PORT: '2525' }).implicitTls, false);
	assert.throws(() => smtpConfig({ ...CREDS, SMTP_PORT: 'submission' }), /not a port number/);
});

test('certificate verification is on and no env key turns it off', () => {
	const opts = tlsOptions(smtpConfig(CREDS));
	assert.equal(opts.rejectUnauthorized, true);
	assert.equal(opts.servername, 'mail.example.org');
	assert.equal(opts.minVersion, 'TLSv1.2');

	// The A7 shape: an operator reaching for an escape hatch finds none, on any
	// spelling the sibling Postgres module ever used.
	const hostile = {
		...CREDS,
		SMTP_INSECURE: 'true',
		SMTP_TLS_INSECURE: 'true',
		SMTP_SSL_INSECURE: 'true',
		SMTP_REJECT_UNAUTHORIZED: 'false',
		NODE_TLS_REJECT_UNAUTHORIZED: '0'
	};
	assert.equal(tlsOptions(smtpConfig(hostile)).rejectUnauthorized, true);
});

test('a CR/LF in any header value aborts the send rather than being stripped', () => {
	// The serializer is the layer that has to hold when a caller forwards an
	// address it did not validate.
	assert.throws(
		() => buildMessage(message({ replyTo: 'a@b.c\r\nBcc: victim@example.com' }), IDENTITY),
		/CR\/LF in Reply-To/
	);
	assert.throws(
		() => buildMessage(message({ subject: 'hi\r\nX-Injected: 1' }), IDENTITY),
		/CR\/LF in Subject/
	);
	assert.throws(
		() => buildMessage(message({ to: ['a@b.c\nRCPT TO:<x@y.z>'] }), IDENTITY),
		/CR\/LF in To/
	);
});

test('a non-ASCII subject is RFC 2047 encoded, folded under the 75-octet limit', () => {
	const subject = 'Welcome to Example Community — you are approved, everyone, at long last';
	const out = buildMessage(message({ subject }), IDENTITY);
	const header = /^Subject: ((?:.|\r\n )*?)\r\n(?!\s)/m.exec(out);
	assert.ok(header, `no Subject header in:\n${out}`);

	const words = header[1].split('\r\n ');
	assert.ok(words.length > 1, 'a long encoded subject was emitted as one over-long word');
	for (const w of words) {
		assert.match(w, /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
		assert.ok(w.length <= 75, `encoded word is ${w.length} octets: ${w}`);
	}
	const decoded = words
		.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8'))
		.join('');
	assert.equal(decoded, subject);
});

test('text + html becomes multipart/alternative, plain part first', () => {
	const out = buildMessage(message({ text: 'plain body', html: '<p>rich body</p>' }), IDENTITY);
	assert.match(out, /^Content-Type: multipart\/alternative; boundary="=_deadbeef"$/m);
	assert.match(out, /^From: "Example Community" <no-reply@example\.org>$/m);

	const parts = out.split('\r\n--=_deadbeef');
	assert.match(parts[1], /Content-Type: text\/plain/);
	assert.match(parts[2], /Content-Type: text\/html/);

	assert.equal(qpDecode(body(parts[1])), 'plain body');
	assert.equal(qpDecode(body(parts[2])), '<p>rich body</p>');
	assert.equal(parts[3], '--\r\n');
});

// A message carrying neither X-Mailer nor User-Agent is an outlier: mail
// clients and sending libraries all stamp one, so scoring rules read the absence
// as a bespoke script. The value is static — identifying the software, not the
// release, because a version string here is free reconnaissance.
test('every message is stamped with an X-Mailer', () => {
	assert.match(buildMessage(message(), IDENTITY), /^X-Mailer: \S+$/m);
	assert.match(
		buildMessage(message({ html: '<p>rich</p>' }), IDENTITY),
		/^X-Mailer: \S+$/m,
		'the multipart branch composes its headers separately and lost the stamp'
	);
	assert.ok(!/^X-Mailer:.*\d+\.\d+/m.test(buildMessage(message(), IDENTITY)), 'version disclosed');
});

// A reply to a sign-in link is a person saying they did not request one, so it
// has to reach somebody. The header is emitted only when a caller supplies it.
test('Reply-To is emitted when set and absent when not', () => {
	assert.match(
		buildMessage(message({ replyTo: 'hello@example.org' }), IDENTITY),
		/^Reply-To: hello@example\.org$/m
	);
	assert.ok(!/^Reply-To:/m.test(buildMessage(message(), IDENTITY)));
});

/** Everything after the part's blank line. */
const body = (p: string) => p.split('\r\n\r\n').slice(1).join('\r\n\r\n');

/** Decode the way a mail client does, so the assertions are about the wire. */
function qpDecode(s: string): string {
	const joined = s.replace(/=\r\n/g, '');
	const bytes: number[] = [];
	for (let i = 0; i < joined.length; i++) {
		if (joined[i] === '=' && /^[0-9A-F]{2}$/.test(joined.slice(i + 1, i + 3))) {
			bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
			i += 2;
		} else {
			bytes.push(joined.charCodeAt(i));
		}
	}
	return Buffer.from(bytes).toString('utf8');
}

// Text parts go out as text. Base64 leaves a text/* body opaque to every filter,
// bounce report and maillog between here and the recipient, which is unusual for
// legitimate mail and was one reason a sign-in message reached a spam folder.
test('text parts are quoted-printable, not base64', () => {
	const out = buildMessage(message({ text: 'plain body', html: '<p>rich</p>' }), IDENTITY);
	const encodings = [...out.matchAll(/Content-Transfer-Encoding: (\S+)/g)].map((m) => m[1]);
	assert.deepEqual(encodings, ['quoted-printable', 'quoted-printable']);
	assert.ok(out.includes('plain body'), 'the plain part is not readable on the wire');
});

test('the escape character, UTF-8 and trailing space all survive a round trip', () => {
	const source = 'a = b\nCaf\u00e9 \u2615\ntrailing space \nend';
	const out = buildMessage(message({ text: source }), IDENTITY);
	const encoded = body(out);
	assert.match(encoded, /a =3D b/, '= must be escaped or a decoder eats the next two chars');
	assert.match(encoded, /Caf=C3=A9 =E2=98=95/, 'multi-byte UTF-8 must go out as octets');
	// A relay that strips invisible trailing whitespace would change the bytes
	// DKIM signed, so it is encoded rather than left literal.
	assert.match(encoded, /trailing space=20/);
	assert.equal(qpDecode(encoded).trimEnd(), source.replace(/\n/g, '\r\n'));
});

// RFC 2045 caps a line at 76 octets including the soft break's own '='. Exceeding
// it is not cosmetic: a relay may rewrap the body and invalidate the signature.
test('no encoded line exceeds 76 octets, and no escape is split across a break', () => {
	const out = buildMessage(
		message({ text: 'long: ' + 'x'.repeat(400) + '\n' + '\u2615'.repeat(60) }),
		IDENTITY
	);
	const encoded = body(out);
	for (const line of encoded.split('\r\n')) {
		assert.ok(line.length <= 76, `line of ${line.length} octets: ${line.slice(0, 20)}…`);
	}
	assert.ok(
		!/=\r\n[0-9A-F]{2}(?![0-9A-F])/.test(encoded.replace(/=\r\n$/, '')),
		'an =XX triplet was split'
	);
	assert.equal(
		qpDecode(encoded).trimEnd(),
		'long: ' + 'x'.repeat(400) + '\r\n' + '\u2615'.repeat(60)
	);
});

// Under base64 this could not arise, so the guard was never reached. Quoted-
// printable preserves a leading dot verbatim, which makes RFC 5321 §4.5.2 live:
// unstuffed, the line reads as end-of-data and the rest of the message is lost.
test('a body line beginning with a dot reaches DATA stuffed', () => {
	const out = buildMessage(message({ text: 'first\n.\nsecond' }), IDENTITY);
	const encoded = body(out);
	assert.match(encoded, /^\.$/m, 'quoted-printable should preserve the dot verbatim');
	assert.match(dotStuff(encoded), /^\.\.$/m, 'the dot reached the wire unstuffed');
	assert.ok(!/^\.$/m.test(dotStuff(encoded)), 'a bare dot line would terminate DATA early');
});

// A plain TCP server standing in for a relay that offers no STARTTLS. The
// property is what the client does NOT do next: no AUTH, no MAIL FROM.
function fakeRelay(caps: string[]): Promise<{ port: number; seen: string[]; close: () => void }> {
	const seen: string[] = [];
	const server = net.createServer((sock) => {
		sock.write('220 relay.example ESMTP\r\n');
		sock.on('data', (chunk) => {
			for (const line of chunk.toString('utf8').split('\r\n').filter(Boolean)) {
				seen.push(line);
				if (/^EHLO /i.test(line)) {
					const lines = ['250-relay.example', ...caps.map((c) => `250-${c}`)];
					sock.write(
						`${lines.slice(0, -1).join('\r\n')}\r\n250 ${caps.at(-1) ?? 'PIPELINING'}\r\n`
					);
				} else {
					sock.write('250 ok\r\n');
				}
			}
		});
	});
	return new Promise((resolve) => {
		server.listen(0, '127.0.0.1', () =>
			resolve({
				port: (server.address() as AddressInfo).port,
				seen,
				close: () => server.close()
			})
		);
	});
}

test('a relay that does not advertise STARTTLS gets no credentials', async () => {
	const relay = await fakeRelay(['PIPELINING', 'AUTH PLAIN LOGIN', 'SIZE 10240000']);
	try {
		const cfg = { ...smtpConfig(CREDS), host: '127.0.0.1', port: relay.port };
		await assert.rejects(
			sendSmtpMail(cfg, { from: 'no-reply@example.org', to: ['a@b.c'] }, 'Subject: x\r\n\r\n'),
			/does not advertise STARTTLS/
		);
	} finally {
		relay.close();
	}

	assert.ok(
		relay.seen.every((l) => !/^AUTH|^MAIL FROM|^DATA/i.test(l)),
		`client kept talking after the downgrade: ${relay.seen.join(' | ')}`
	);
});

test('a STARTTLS relay is upgraded before AUTH, never authenticated in clear', async () => {
	const relay = await fakeRelay(['STARTTLS', 'AUTH PLAIN LOGIN']);
	try {
		const cfg = { ...smtpConfig(CREDS), host: '127.0.0.1', port: relay.port };
		// The fake answers 250 to STARTTLS, so the upgrade never happens and the
		// handshake fails — which is the point: failure, not a plaintext AUTH.
		await assert.rejects(
			sendSmtpMail(cfg, { from: 'no-reply@example.org', to: ['a@b.c'] }, 'Subject: x\r\n\r\n')
		);
	} finally {
		relay.close();
	}

	assert.ok(
		relay.seen.some((l) => l === 'STARTTLS'),
		'client never asked to upgrade'
	);
	assert.ok(
		relay.seen.every((l) => !/^AUTH/i.test(l)),
		`credentials went out in clear: ${relay.seen.join(' | ')}`
	);
});

test('an envelope address carrying SMTP syntax is refused before connecting', async () => {
	const cfg = smtpConfig(CREDS);
	await assert.rejects(
		sendSmtpMail(cfg, { from: 'no-reply@example.org', to: ['a@b.c>\r\nRCPT TO:<x@y.z'] }, 'x'),
		/not usable as an SMTP envelope address/
	);
	await assert.rejects(
		sendSmtpMail(cfg, { from: 'no-reply@example.org', to: [] }, 'x'),
		/no recip/
	);
});
