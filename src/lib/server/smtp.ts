// ESMTP submission client, over Node's own `net`/`tls`. It implements the
// subset a transactional sender needs — greeting, EHLO, STARTTLS, AUTH, one
// message, QUIT — and nothing else, because every branch not written here is a
// branch that cannot silently downgrade the connection.
//
// The rule it exists to enforce, and B07's in a different protocol: submission
// is authenticated and the certificate is verified. There is no env key that
// relaxes either, no plaintext fallback, and port 25 is refused by name. A
// certificate error on the mail path is a certificate to fix, not a flag to set.

import net from 'node:net';
import tls from 'node:tls';

import type { MailMessage } from './mail';

type EnvSource = Record<string, string | undefined>;

export type SmtpConfig = {
	host: string;
	port: number;
	user: string;
	password: string;
	implicitTls: boolean;
};

export type SmtpEnvelope = { from: string; to: string[] };

const SUBMISSION_PORT = 587;
const IMPLICIT_TLS_PORT = 465;

const CONNECT_TIMEOUT_MS = 10_000;
const IO_TIMEOUT_MS = 20_000;

// RFC 5321 §4.5.3.1.5 caps a reply line at 512 octets. The slack absorbs a
// chatty banner; the ceilings exist so a hostile or broken server cannot grow
// this process's heap while a request waits on it.
const LINE_MAX = 4096;
const REPLY_MAX = 64 * 1024;

/**
 * Read the submission credentials out of the environment, refusing anything
 * that would put mail on the wire unauthenticated or in clear.
 */
export function smtpConfig(env: EnvSource): SmtpConfig {
	const host = env.SMTP_HOST?.trim();
	if (!host) throw new Error('SMTP_HOST is unset, so there is no relay to submit to.');

	const rawPort = env.SMTP_PORT?.trim() || String(SUBMISSION_PORT);
	const port = Number(rawPort);
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`SMTP_PORT=${JSON.stringify(env.SMTP_PORT)} is not a port number.`);
	}
	// 25 is MTA-to-MTA relay: no submission credentials are expected there and on
	// most paths no TLS either. A client that can be pointed at it has a
	// plaintext route, however the value got typed.
	if (port === 25) {
		throw new Error(
			'SMTP_PORT=25 is relay, not submission. Use 587 (STARTTLS) or 465 (implicit TLS) with credentials.'
		);
	}

	const user = env.SMTP_USER?.trim();
	const password = env.SMTP_PASSWORD;
	if (!user || !password) {
		throw new Error(
			'SMTP_USER and SMTP_PASSWORD are both required — this client does not submit unauthenticated.'
		);
	}

	return { host, port, user, password, implicitTls: port === IMPLICIT_TLS_PORT };
}

/**
 * TLS options for both the implicit-TLS connection and the STARTTLS upgrade.
 * `rejectUnauthorized: true` is Node's default and is stated anyway: A7 is what
 * an unstated default plus one desperate edit looks like, and a reader checking
 * this posture should find it written down rather than infer it from absence.
 */
export function tlsOptions(cfg: SmtpConfig): tls.ConnectionOptions {
	return {
		servername: cfg.host,
		rejectUnauthorized: true,
		minVersion: 'TLSv1.2'
	};
}

// ---------------------------------------------------------------- wire format

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

// A header value carrying CR or LF is header injection: everything after it is
// a header, or a body, of the sender's choosing. Every header value passes
// through here, so the rule holds for a caller that forwards user input without
// validating it first.
function headerValue(name: string, value: string): string {
	if (/[\r\n]/.test(value)) throw new Error(`CR/LF in ${name} header value`);
	return value;
}

// RFC 2047 encoded-word, folded so no single word exceeds the 75-octet limit.
// Chunking walks code points, not bytes, so a multi-byte character is never
// split across two words; 45 bytes of input is a multiple of 3, which keeps
// each base64 run padding-free and its encoded form at 60 of the 63 available.
function encodeWords(value: string): string {
	const words: string[] = [];
	let chunk = '';
	const flush = () => {
		if (chunk) words.push(`=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`);
		chunk = '';
	};
	for (const ch of value) {
		if (Buffer.byteLength(chunk + ch, 'utf8') > 45) flush();
		chunk += ch;
	}
	flush();
	return words.join('\r\n ');
}

function encodeHeader(name: string, value: string): string {
	const v = headerValue(name, value);
	return ASCII_PRINTABLE.test(v) ? v : encodeWords(v);
}

export function addressHeader(name: string, display: string | undefined, addr: string): string {
	const a = headerValue(name, addr);
	if (!display) return a;
	// An encoded-word is not a quoted-string and must not be wrapped in quotes;
	// a plain-ASCII phrase is quoted so a comma or a dot in it stays one phrase.
	return ASCII_PRINTABLE.test(display)
		? `"${headerValue(name, display).replace(/["\\]/g, '')}" <${a}>`
		: `${encodeWords(display)} <${a}>`;
}

// RFC 2045 §6.7. Text parts go out quoted-printable rather than base64 so the
// message reads as text on the wire: a filter, a bounce report, or a person
// running `tail` on a maillog sees the words. Base64 leaves a text/* part as an
// opaque blob that has to be decoded before anything can be said about it, which
// is both unusual for legitimate mail and an obstacle to every downstream tool.
//
// Headers keep base64 (`encodeWords`, RFC 2047 =?UTF-8?B?) — a different
// encoding in a different place, and the right one there.
function qpEncode(text: string): string {
	// Normalise first: a lone CR or a CRLF both mean one hard break, and encoding
	// the CR as =0D would leave a literal escape in the middle of a sentence.
	const bytes = Buffer.from(text.replace(/\r\n?/g, '\n'), 'utf8');
	const lines: string[] = [];
	let line = '';

	// A soft break is `=` then CRLF, and the `=` counts toward the 76-octet
	// ceiling, so content stops at 75. Tokens are at most three octets and are
	// appended whole, which is what keeps an `=XX` triplet off a line boundary.
	const add = (token: string) => {
		if (line.length + token.length > 75) {
			lines.push(line + '=');
			line = '';
		}
		line += token;
	};
	const hex = (b: number) => '=' + b.toString(16).toUpperCase().padStart(2, '0');

	for (const b of bytes) {
		if (b === 0x0a) {
			// Trailing whitespace before a break is invisible and is stripped by
			// some relays, which would change the bytes DKIM signed. Encoding it
			// is what makes the body survive the trip intact.
			const last = line.at(-1);
			if (last === ' ' || last === '\t') {
				line = line.slice(0, -1);
				add(hex(last === ' ' ? 0x20 : 0x09));
			}
			lines.push(line);
			line = '';
			continue;
		}
		if (b === 0x3d)
			add('=3D'); // the escape character itself
		else if (b === 0x20 || b === 0x09) add(String.fromCharCode(b));
		else if (b >= 0x21 && b <= 0x7e) add(String.fromCharCode(b));
		else add(hex(b));
	}
	lines.push(line);

	return lines.join('\r\n');
}

function part(contentType: string, body: string): string {
	return [
		`Content-Type: ${contentType}; charset=UTF-8`,
		'Content-Transfer-Encoding: quoted-printable',
		'',
		qpEncode(body)
	].join('\r\n');
}

// A message with no X-Mailer and no User-Agent is an outlier: every mail client
// and every reputable sending library stamps one, so scoring rules treat the
// absence as a marker of a bespoke script. Static and version-free — the point
// is to look like software, not to tell a stranger which release is deployed.
const X_MAILER = 'lorem-host';

export type MessageIdentity = {
	from: string;
	messageId: string;
	date: string;
	boundary: string;
};

/**
 * Serialise a message to RFC 5322 form. The variable parts — Message-ID, Date,
 * MIME boundary — are passed in rather than generated here so the output is a
 * pure function of its inputs and a test can assert on the bytes.
 */
export function buildMessage(msg: MailMessage, id: MessageIdentity): string {
	if (!msg.to.length) throw new Error('message has no recipients');
	if (!msg.text && !msg.html) throw new Error('message has neither a text nor an HTML body');

	const headers = [
		`From: ${addressHeader('From', msg.fromName, id.from)}`,
		`To: ${msg.to.map((t) => addressHeader('To', undefined, t)).join(', ')}`,
		`Subject: ${encodeHeader('Subject', msg.subject)}`,
		`Date: ${headerValue('Date', id.date)}`,
		`Message-ID: ${headerValue('Message-ID', id.messageId)}`,
		'MIME-Version: 1.0',
		`X-Mailer: ${X_MAILER}`
	];
	if (msg.replyTo) headers.push(`Reply-To: ${addressHeader('Reply-To', undefined, msg.replyTo)}`);

	if (msg.text && msg.html) {
		const b = headerValue('boundary', id.boundary);
		return [
			...headers,
			`Content-Type: multipart/alternative; boundary="${b}"`,
			'',
			// Least-faithful representation first (RFC 2046 §5.1.4): a client that
			// renders HTML picks the last part it understands.
			`--${b}`,
			part('text/plain', msg.text),
			`--${b}`,
			part('text/html', msg.html),
			`--${b}--`,
			''
		].join('\r\n');
	}

	return [
		...headers,
		part(msg.html ? 'text/html' : 'text/plain', msg.html ?? msg.text ?? ''),
		''
	].join('\r\n');
}

// RFC 5321 §4.5.2. A body line beginning with '.' would otherwise be read as the
// end-of-data marker, truncating the message there. Quoted-printable preserves a
// leading '.' verbatim, so this is reached by any body with one at the start of
// a line — under the old base64 encoding it could not be, which is why the
// property belongs to the DATA transfer rather than to the body encoding.
export function dotStuff(data: string): string {
	return data.replace(/^\./gm, '..');
}

// ---------------------------------------------------------------- conversation

type Reply = { code: number; lines: string[] };

type Reader = {
	next(): Promise<Reply>;
	buffered(): number;
	detach(): void;
};

function reader(socket: net.Socket): Reader {
	let buf = '';
	let lines: string[] = [];
	const ready: Reply[] = [];
	let pending: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
	let failure: Error | null = null;

	const fail = (err: Error) => {
		failure ??= err;
		pending?.reject(failure);
		pending = null;
	};

	const onData = (chunk: Buffer) => {
		buf += chunk.toString('utf8');
		if (buf.length > REPLY_MAX) return fail(new Error('SMTP reply exceeded the read ceiling'));
		let idx: number;
		while ((idx = buf.indexOf('\r\n')) !== -1) {
			const line = buf.slice(0, idx);
			buf = buf.slice(idx + 2);
			if (line.length > LINE_MAX) return fail(new Error('SMTP reply line exceeded the ceiling'));
			const m = /^(\d{3})([ -]?)(.*)$/.exec(line);
			if (!m)
				return fail(new Error(`unparseable SMTP reply: ${JSON.stringify(line.slice(0, 80))}`));
			lines.push(m[3]);
			if (m[2] === '-') continue;
			const reply: Reply = { code: Number(m[1]), lines };
			lines = [];
			if (pending) {
				const p = pending;
				pending = null;
				p.resolve(reply);
			} else {
				ready.push(reply);
			}
		}
	};

	const onError = (err: Error) => fail(err);
	const onClose = () => fail(new Error('SMTP connection closed by the server'));
	const onTimeout = () => {
		socket.destroy();
		fail(new Error(`SMTP server did not answer within ${IO_TIMEOUT_MS}ms`));
	};

	socket.on('data', onData);
	socket.on('error', onError);
	socket.on('close', onClose);
	socket.on('timeout', onTimeout);
	socket.setTimeout(IO_TIMEOUT_MS);

	return {
		next() {
			const queued = ready.shift();
			if (queued) return Promise.resolve(queued);
			if (failure) return Promise.reject(failure);
			return new Promise<Reply>((resolve, reject) => {
				pending = { resolve, reject };
			});
		},
		buffered: () => buf.length,
		detach() {
			socket.off('data', onData);
			socket.off('error', onError);
			socket.off('close', onClose);
			socket.off('timeout', onTimeout);
		}
	};
}

function write(socket: net.Socket, line: string): void {
	socket.write(`${line}\r\n`);
}

// The failure that matters is the one an operator reads at 03:00 with sign-in
// down, so it names the step, the code and what the server actually said.
async function expect(io: Reader, codes: number[], step: string): Promise<Reply> {
	const reply = await io.next();
	if (!codes.includes(reply.code)) {
		throw new Error(`SMTP ${step} refused: ${reply.code} ${reply.lines.join(' / ')}`);
	}
	return reply;
}

function parseCapabilities(reply: Reply): Map<string, string[]> {
	const caps = new Map<string, string[]>();
	// The first line of an EHLO reply is the greeting, not a capability.
	for (const line of reply.lines.slice(1)) {
		const [keyword, ...params] = line.trim().split(/\s+/);
		if (keyword)
			caps.set(
				keyword.toUpperCase(),
				params.map((p) => p.toUpperCase())
			);
	}
	return caps;
}

async function ehlo(socket: net.Socket, io: Reader, name: string): Promise<Map<string, string[]>> {
	write(socket, `EHLO ${name}`);
	return parseCapabilities(await expect(io, [250], 'EHLO'));
}

async function authenticate(
	socket: net.Socket,
	io: Reader,
	cfg: SmtpConfig,
	caps: Map<string, string[]>
): Promise<void> {
	const mechanisms = caps.get('AUTH') ?? [];
	const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

	if (mechanisms.includes('PLAIN')) {
		write(socket, `AUTH PLAIN ${b64(`\0${cfg.user}\0${cfg.password}`)}`);
		await expect(io, [235], 'AUTH PLAIN');
		return;
	}
	if (mechanisms.includes('LOGIN')) {
		write(socket, 'AUTH LOGIN');
		await expect(io, [334], 'AUTH LOGIN');
		write(socket, b64(cfg.user));
		await expect(io, [334], 'AUTH LOGIN username');
		write(socket, b64(cfg.password));
		await expect(io, [235], 'AUTH LOGIN password');
		return;
	}
	throw new Error(
		`${cfg.host}:${cfg.port} advertises no AUTH mechanism this client speaks (offered: ${
			mechanisms.join(', ') || 'none'
		}).`
	);
}

function connect(cfg: SmtpConfig): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const socket = cfg.implicitTls
			? tls.connect({ host: cfg.host, port: cfg.port, ...tlsOptions(cfg) })
			: net.connect({ host: cfg.host, port: cfg.port });
		const timer = setTimeout(() => {
			socket.destroy();
			reject(new Error(`SMTP connect to ${cfg.host}:${cfg.port} timed out`));
		}, CONNECT_TIMEOUT_MS);
		const settle = (err?: Error) => {
			clearTimeout(timer);
			socket.off('error', onError);
			if (err) reject(err);
			else resolve(socket);
		};
		const onError = (err: Error) => settle(err);
		socket.once('error', onError);
		socket.once(cfg.implicitTls ? 'secureConnect' : 'connect', () => settle());
	});
}

function upgrade(socket: net.Socket, cfg: SmtpConfig): Promise<net.Socket> {
	return new Promise((resolve, reject) => {
		const secure = tls.connect({ socket: socket as net.Socket, ...tlsOptions(cfg) });
		secure.once('error', reject);
		secure.once('secureConnect', () => {
			secure.off('error', reject);
			resolve(secure);
		});
	});
}

function assertEnvelopeAddress(addr: string): string {
	if (!addr || /[\r\n<>\s]/.test(addr)) {
		throw new Error(`not usable as an SMTP envelope address: ${JSON.stringify(addr)}`);
	}
	return addr;
}

/**
 * Submit one message and close. No connection pooling: the volume here is a
 * handful of messages an hour, and a pool is a cache of authenticated sessions
 * to keep warm across a restart nobody is watching.
 */
export async function sendSmtpMail(
	cfg: SmtpConfig,
	envelope: SmtpEnvelope,
	data: string
): Promise<void> {
	const from = assertEnvelopeAddress(envelope.from);
	const recipients = envelope.to.map(assertEnvelopeAddress);
	if (!recipients.length) throw new Error('message has no recipients');
	const ehloName = from.slice(from.indexOf('@') + 1) || cfg.host;

	// A socket that emits 'error' with no listener takes the process down, and
	// this one loses its listener for the window between detach() and the TLS
	// wrap. The reader's own handler is what reports; this one only keeps a reset
	// peer from turning a failed send into a restart.
	const open: net.Socket[] = [];
	const hold = (s: net.Socket) => {
		s.on('error', () => {});
		open.push(s);
		return s;
	};

	try {
		let socket = hold(await connect(cfg));
		let io = reader(socket);
		await expect(io, [220], 'greeting');
		let caps = await ehlo(socket, io, ehloName);

		if (!cfg.implicitTls) {
			if (!caps.has('STARTTLS')) {
				throw new Error(
					`${cfg.host}:${cfg.port} does not advertise STARTTLS. Refusing to submit credentials in clear.`
				);
			}
			write(socket, 'STARTTLS');
			await expect(io, [220], 'STARTTLS');
			// Anything already buffered arrived before the handshake and was written
			// by whoever holds the plaintext path — the STARTTLS command-injection
			// class (CVE-2011-0411). Bytes that predate TLS never become bytes TLS
			// vouched for.
			if (io.buffered() > 0) {
				throw new Error('server sent data ahead of the TLS handshake; aborting');
			}
			io.detach();
			socket = hold(await upgrade(socket, cfg));
			io = reader(socket);
			// The pre-TLS capability list was unauthenticated and is discarded.
			caps = await ehlo(socket, io, ehloName);
		}

		await authenticate(socket, io, cfg, caps);

		write(socket, `MAIL FROM:<${from}>`);
		await expect(io, [250], 'MAIL FROM');
		for (const rcpt of recipients) {
			write(socket, `RCPT TO:<${rcpt}>`);
			await expect(io, [250, 251], 'RCPT TO');
		}
		write(socket, 'DATA');
		await expect(io, [354], 'DATA');
		socket.write(`${dotStuff(data)}\r\n.\r\n`);
		await expect(io, [250], 'message');
		write(socket, 'QUIT');
	} finally {
		for (const s of open) s.destroy();
	}
}
