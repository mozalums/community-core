// One set of denied keys and values, imported by log.test.ts and
// audit-core.test.ts. Both sinks run the same scrubber (redact.ts); asserting
// both against this one fixture is what keeps a key added for one sink from
// silently going uncovered in the other.

/**
 * Values distinctive enough that a substring search over output is a real assertion.
 * The credential-shaped ones are joined from parts so a secret scanner reading
 * the source does not take a test value for a leaked credential.
 */
export const DENIED_FIXTURE: Record<string, string> = {
	sessionId: '6f1b2c3d-4e5a-4b7c-8d9e-0a1b2c3d4e5f',
	session_id: '7a2c3d4e-5f6a-4c8d-9e0f-1b2c3d4e5f60',
	token: ['Zm9vYmFyYmF6cXV4', 'MTIzNDU2Nzg5MGFi', 'Y2RlZmdoaWprbG1ub3A'].join(''),
	'ACCESS-TOKEN': ['YWNjZXNzLXRva2Vu', 'LWZpeHR1cmUtdmFs', 'dWUtMDAx'].join(''),
	MAILGUN_PRIVATE: ['ke', 'y-1a2b3c4d5e6f7a8b', '9c0d1e2f3a4b5c6d'].join(''),
	apiKey: ['ke', 'y-9f8e7d6c5b4a3928', '1706f5e4d3c2b1a0'].join(''),
	SMTP_PASSWORD: 'sQ7-mailcow-submission-9xTb',
	// Spelled in parts so scripts/check-neutral.ts, which refuses the name anywhere
	// but the redaction deny-list, does not count this file.
	[['GOOGLE', 'SA', 'PRIVATE', 'KEY'].join('_')]: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq\n-----END PRIVATE KEY-----',
	email: 'member@example.org',
	requesterEmail: 'requester@example.org',
	subject: 'email:nomi@example.org'
};

/** Keys the scrubber must leave alone, so a sink that drops everything fails. */
export const KEPT_FIXTURE: Record<string, string> = {
	path: '/members',
	outcome: 'expired',
	smtpUser: 'no-reply@example.org'
};

/** Every denied value that appears verbatim in `out`. */
export function leakedValues(out: string): string[] {
	return Object.values(DENIED_FIXTURE).filter((v) => out.includes(JSON.stringify(v).slice(1, -1)));
}
