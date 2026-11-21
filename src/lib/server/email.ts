// The messages this app sends. Content only: subject, bodies, recipients.
// Transport — which provider, which sending domain, which credentials — belongs
// to `mail.ts`, so adding a message means composing one more object and none of
// them learn SMTP.

import { magicLinkEmailParts } from '$lib/server/magic-link-message';
import { APP_BASE_URL, COMPANY_NAME, COMPANY_SUPPORT_EMAIL } from '$lib/site';
import { brand, mail, site, theme } from '$skin/skin.yaml';

import { env } from '$env/dynamic/private';
import { sendMail } from '$lib/server/mail';

// Values land in attributes as well as text, so quotes are escaped too.
const esc = (s: string) =>
	s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');

/**
 * Notify an admin that someone requested membership. Plain listing of the request
 * + a button to the approval screen. Best-effort — callers should not fail the
 * request if this throws. Returns false when NOTIFY_ADMIN_ADDRESS names nobody,
 * so the caller can log that the request landed unwatched.
 */
export async function sendMembershipRequestNotice(args: {
	groupName: string;
	requesterEmail: string;
	rows: { label: string; value: string }[];
	reviewUrl: string;
}): Promise<boolean> {
	const rowsHtml = args.rows
		.map(
			(r) =>
				`<tr><td style="padding:4px 12px 4px 0;color:#6b7280;white-space:nowrap;vertical-align:top">${esc(r.label)}</td><td style="padding:4px 0;color:#111827">${esc(r.value || '—')}</td></tr>`
		)
		.join('');
	const html = `<div style="font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827;line-height:1.5">
<p style="margin:0 0 12px">New membership request for <strong>${esc(args.groupName)}</strong>:</p>
<table style="border-collapse:collapse;margin:0 0 20px">${rowsHtml}</table>
<a href="${esc(args.reviewUrl)}" style="display:inline-block;background:${theme.light.accent};color:${theme.light.accentContrast};text-decoration:none;font-weight:600;padding:10px 18px;border-radius:9999px">Review request &rarr;</a>
</div>`;

	const text =
		`New membership request for ${args.groupName}:\n\n` +
		args.rows.map((r) => `${r.label}: ${r.value || '—'}`).join('\n') +
		`\n\nReview: ${args.reviewUrl}\n`;

	// NOTIFY_ADMIN_ADDRESS may be a comma-separated list — send to each one.
	const recipients = (env.NOTIFY_ADMIN_ADDRESS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	if (!recipients.length) return false;

	await sendMail({
		fromName: COMPANY_NAME,
		to: recipients,
		subject: `New membership request — ${args.groupName}`,
		html,
		text,
		tag: 'request-notice'
	});
	return true;
}

/**
 * Tell an approved requester they're in, with a button to sign in. Best-effort —
 * callers should not fail the approval if this throws.
 */
export async function sendMembershipApprovedEmail(args: {
	to: string;
	groupName: string;
	signInUrl: string;
}): Promise<void> {
	const g = esc(args.groupName);

	const html = `<div style="font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827;line-height:1.5;max-width:480px;margin:0 auto;text-align:center">
<img src="${APP_BASE_URL}/${brand.email_logo}" alt="${esc(site.name)}" width="180" style="max-width:100%;margin:0 0 20px;border:0" />
<h1 style="font-size:22px;font-weight:800;margin:0 0 8px">You're in!</h1>
<p style="margin:0 0 24px;color:#374151">Your membership to <strong>${g}</strong> has been approved. Welcome — sign in to explore the directory and reconnect with fellow members.</p>
<a href="${esc(args.signInUrl)}" style="display:inline-block;background:${theme.light.accent};color:${theme.light.accentContrast};text-decoration:none;font-weight:600;padding:12px 22px;border-radius:9999px">Sign in to ${g} &rarr;</a>
</div>`;

	const text =
		`You're in! Your membership to ${args.groupName} has been approved.\n\n` +
		`Sign in to explore the directory: ${args.signInUrl}\n`;

	await sendMail({
		fromName: mail.from_name,
		to: [args.to],
		subject: `Welcome to ${args.groupName} — you're approved`,
		html,
		text,
		tag: 'approved'
	});
}

// The shared frame of the two address-change messages: logo, heading, a
// paragraph, one button, and the same in plain text.
function actionMessage(args: { heading: string; body: string; button: string; url: string }) {
	const html = `<div style="font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;color:#111827;line-height:1.5;max-width:480px;margin:0 auto;text-align:center">
<img src="${APP_BASE_URL}/${brand.email_logo}" alt="${esc(site.name)}" width="180" style="max-width:100%;margin:0 0 20px;border:0" />
<h1 style="font-size:22px;font-weight:800;margin:0 0 8px">${esc(args.heading)}</h1>
<p style="margin:0 0 24px;color:#374151">${esc(args.body)}</p>
<a href="${esc(args.url)}" style="display:inline-block;background:${theme.light.accent};color:${theme.light.accentContrast};text-decoration:none;font-weight:600;padding:12px 22px;border-radius:9999px">${esc(args.button)} &rarr;</a>
</div>`;
	const text = `${args.heading}\n\n${args.body}\n\n${args.button}: ${args.url}\n`;
	return { html, text };
}

/** The link that proves the member controls the address they asked to move to. */
export async function sendEmailChangeConfirm(args: {
	toEmail: string;
	url: string;
}): Promise<void> {
	const { html, text } = actionMessage({
		heading: 'Confirm your new sign-in email',
		body: `Someone asked to make this address the sign-in email for their ${site.name} account. If that was you, confirm within 30 minutes. If not, ignore this message and nothing changes.`,
		button: 'Confirm this address',
		url: args.url
	});
	await sendMail({
		fromName: mail.from_name,
		to: [args.toEmail],
		replyTo: COMPANY_SUPPORT_EMAIL,
		subject: `Confirm your new sign-in email for ${site.name}`,
		html,
		text,
		tag: 'email-change'
	});
}

/** Tells the old address it no longer signs in, with seven days to undo it. */
export async function sendEmailChangedNotice(args: {
	toEmail: string;
	newEmail: string;
	revertUrl: string;
}): Promise<void> {
	const { html, text } = actionMessage({
		heading: 'Your sign-in email was changed',
		body: `Your ${site.name} account now signs in as ${args.newEmail}, and this address no longer does. If you did not make this change, undo it within 7 days: that puts this address back, signs out every session and removes the account's passkeys.`,
		button: 'Undo this change',
		url: args.revertUrl
	});
	await sendMail({
		fromName: mail.from_name,
		to: [args.toEmail],
		replyTo: COMPANY_SUPPORT_EMAIL,
		subject: `Your sign-in email for ${site.name} was changed`,
		html,
		text,
		tag: 'email-changed'
	});
}

/**
 * Send the passwordless "sign-in link" email.
 *
 * Composition lives in magic-link-message.ts, which takes the deployment's
 * strings as arguments so it stays testable without Vite. This function is the
 * seam that supplies them.
 */
export async function sendMagicLinkEmail(args: { toEmail: string; url: string }): Promise<void> {
	const { subject, text, html } = magicLinkEmailParts(args.url, {
		baseUrl: APP_BASE_URL,
		emailLogo: brand.email_logo,
		accent: theme.light.accent,
		accentContrast: theme.light.accentContrast,
		subject: mail.sign_in_subject,
		siteName: site.name,
		signature: mail.signature,
		credit: mail.credit
	});
	// Someone who receives a sign-in link they did not request will reply to it,
	// and a transactional sender offering no route back to a person is itself a
	// deliverability signal. From: stays on the signed domain for DMARC.
	await sendMail({
		fromName: mail.from_name,
		to: [args.toEmail],
		replyTo: COMPANY_SUPPORT_EMAIL,
		subject,
		text,
		html,
		tag: 'login'
	});
}
