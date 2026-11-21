// The one seam every outbound message crosses. `email.ts` composes content and
// hands it here; only this module knows whether the bytes leave over SMTP or
// over an HTTP API, which is what makes swapping the provider a config change
// rather than four rewrites.
//
// Two transports live here on purpose, for exactly one release. The failure
// mode of a bad mail cutover is that nobody can sign in, and editing code is a
// poor thing to be doing at that moment: MAIL_TRANSPORT=mailgun in the secrets
// file plus a container restart is the rollback. The Mailgun branch — and the
// mailgun.js / form-data dependencies with it — comes out once the mailcow path
// has carried a release without one.

import crypto from 'node:crypto';

import Mailgun from 'mailgun.js';
import formData from 'form-data';

import { APP_APEX_DOMAIN } from '$lib/site';
import { env } from '$env/dynamic/private';
import { log } from '$lib/server/log';
import { addressHeader, buildMessage, sendSmtpMail, smtpConfig } from '$lib/server/smtp';

export type MailTag = 'request-notice' | 'approved' | 'login' | 'email-change' | 'email-changed';

// Messages whose link carries a single-use token.
const TOKEN_TAGS: ReadonlySet<MailTag> = new Set(['login', 'email-change', 'email-changed']);

export type MailMessage = {
	/** Display name for the From: address. The address itself is the transport's. */
	fromName: string;
	to: string[];
	subject: string;
	text?: string;
	html?: string;
	replyTo?: string;
	tag: MailTag;
};

export type MailTransport = 'smtp' | 'mailgun';

/**
 * `smtp` is the default, so an unset variable takes the mailcow path rather
 * than a retired one. An unrecognised value throws instead of falling back:
 * a typo here would silently send a release's mail over the wrong provider
 * from the wrong domain.
 */
export function mailTransport(e: Record<string, string | undefined> = env): MailTransport {
	const raw = (e.MAIL_TRANSPORT || 'smtp').trim().toLowerCase();
	if (raw !== 'smtp' && raw !== 'mailgun') {
		throw new Error(
			`MAIL_TRANSPORT=${JSON.stringify(e.MAIL_TRANSPORT)} is neither "smtp" nor "mailgun".`
		);
	}
	return raw;
}

/**
 * Whether the selected transport has enough configuration to send. Only the
 * dev sign-in fallback consults this — a production send that is missing
 * credentials must fail loudly rather than degrade.
 */
export function mailConfigured(): boolean {
	return mailTransport() === 'mailgun'
		? Boolean(env.MAILGUN_PRIVATE)
		: Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASSWORD);
}

// The envelope and header sender. mailcow hosts this domain, so the address a
// recipient sees is the domain that signed the message — which is the whole
// point of moving off a sending domain shared with another project.
function smtpFrom(): string {
	return env.MAIL_FROM?.trim() || `no-reply@${APP_APEX_DOMAIN}`;
}

async function sendViaSmtp(msg: MailMessage): Promise<void> {
	const cfg = smtpConfig(env);
	const from = smtpFrom();
	const data = buildMessage(msg, {
		from,
		messageId: `<${crypto.randomUUID()}@${from.slice(from.indexOf('@') + 1)}>`,
		// toUTCString() renders the obsolete `GMT` zone; RFC 5322 §3.3 wants a
		// numeric offset.
		date: new Date().toUTCString().replace(/GMT$/, '+0000'),
		boundary: `=_${crypto.randomBytes(16).toString('hex')}`
	});
	await sendSmtpMail(cfg, { from, to: msg.to }, data);
}

// --------------------------------------------------------- retiring transport

const mailgun = new Mailgun(formData);
let mg: ReturnType<typeof mailgun.client> | null = null;

function mailgunClient(): ReturnType<typeof mailgun.client> {
	if (mg) return mg;
	const key = env.MAILGUN_PRIVATE;
	if (!key) throw new Error('MAILGUN_PRIVATE unset');
	mg = mailgun.client({ username: 'api', key });
	return mg;
}

/**
 * The Mailgun sending domain. There is no fallback: a default would send from a
 * domain this deployment does not own, which fails DMARC at best and speaks
 * for someone else at worst.
 */
export function mailgunDomain(e: Record<string, string | undefined>): string {
	const domain = e.MAIL_DOMAIN?.trim();
	if (!domain) {
		throw new Error(
			'MAIL_TRANSPORT=mailgun needs MAIL_DOMAIN, the Mailgun domain this deployment sends from. ' +
				'Set MAIL_DOMAIN, or unset MAIL_TRANSPORT to send over SMTP.'
		);
	}
	return domain;
}

/**
 * The boot check: a transport that cannot name its sender refuses to start
 * rather than failing on the first sign-in. Checks only what has no default.
 */
export function assertMailConfig(e: Record<string, string | undefined> = env): void {
	if (mailTransport(e) === 'mailgun') mailgunDomain(e);
}

async function sendViaMailgun(msg: MailMessage): Promise<void> {
	const domain = mailgunDomain(env);
	const common = {
		// Mailgun takes the From header as given, so it goes through the same
		// CR/LF refusal and phrase quoting as the SMTP path.
		from: addressHeader('From', msg.fromName, `no-reply@${domain}`),
		...(msg.replyTo ? { 'h:Reply-To': msg.replyTo } : {}),
		to: msg.to,
		subject: msg.subject,
		'o:tag': msg.tag,
		// Load-bearing on this transport alone: Mailgun rewrites links for click
		// tracking, and a rewritten magic link is a token the confirm hop never
		// sees. mailcow rewrites nothing, so the SMTP path carries no equivalent.
		...(TOKEN_TAGS.has(msg.tag)
			? { 'o:tracking': 'no' as const, 'o:tracking-clicks': 'no' as const }
			: {})
	};

	// MailgunMessageData is a union keyed on which body is present, so the body
	// has to be spelled out at each construction rather than merged in
	// conditionally — a text-only message with `html: undefined` is a different
	// member of that union, not the same one with a hole.
	await mailgunClient().messages.create(
		domain,
		msg.html && msg.text
			? { ...common, html: msg.html, text: msg.text }
			: msg.html
				? { ...common, html: msg.html }
				: { ...common, text: msg.text ?? '' }
	);
}

/**
 * Send one message over the configured transport. Throws on failure; callers
 * decide whether their flow survives it.
 */
export async function sendMail(msg: MailMessage): Promise<void> {
	const transport = mailTransport();
	try {
		if (transport === 'mailgun') await sendViaMailgun(msg);
		else await sendViaSmtp(msg);
	} catch (err) {
		// `tag` replaces the per-sender event names this consolidated, so grouping
		// on it still separates a broken request notice from a broken sign-in.
		log.error('mail.send-failed', { transport, tag: msg.tag, error: String(err) });
		throw err;
	}
	log.info('mail.sent', { transport, tag: msg.tag, recipients: msg.to.length });
}
