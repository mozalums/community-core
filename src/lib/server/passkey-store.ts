// The WebAuthn ceremonies and the credential table. Kept apart from
// ./passkeys, which holds what a page needs to decide whether to offer them,
// because this module reaches Redis and Postgres and a page module that
// imported it could no longer load in a test without both.

import crypto from 'node:crypto';
import {
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AuthenticationResponseJSON,
	type PublicKeyCredentialCreationOptionsJSON,
	type PublicKeyCredentialRequestOptionsJSON,
	type RegistrationResponseJSON
} from '@simplewebauthn/server';
import { decodeClientDataJSON, isoBase64URL } from '@simplewebauthn/server/helpers';
import { env } from '$env/dynamic/private';
import { site } from '$skin/skin.yaml';
import { APP_APEX_DOMAIN, siteUrl } from '$lib/site';
import { query } from '$lib/server/postgres';
import { redis } from '$lib/server/redis';
import { log } from '$lib/server/log';
import type { PasskeySummary } from '$lib/server/passkeys';

const CHALLENGE_TTL = 5 * 60;
const NICKNAME_MAX = 64;

const PREFIX = (env.LOREM_REDIS_PREFIX || 'lorem-prod').replace(/:$/, '');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const regKey = (sessionId: string) => `${PREFIX}:passkey:reg:${sha256(sessionId)}`;
const authKey = (challenge: string) => `${PREFIX}:passkey:auth:${sha256(challenge)}`;

/**
 * The relying party. The ID is the apex so a passkey made on any subdomain
 * works on every other one; the origin is the one this deployment serves
 * pages from.
 */
export function relyingParty(): { rpID: string; origins: string[] } {
	return { rpID: APP_APEX_DOMAIN, origins: [siteUrl(env.ORIGIN)] };
}

// The member's uuid as the WebAuthn user handle, so an assertion names the
// member its credential was made for and a mismatched row can be refused.
const userHandle = (memberId: string) => Buffer.from(memberId.replace(/-/g, ''), 'hex');

export async function listPasskeys(memberId: string): Promise<PasskeySummary[]> {
	const { rows } = await query<{
		id: Buffer;
		nickname: string;
		created_at: Date;
		last_used_at: Date | null;
	}>(
		`SELECT id, nickname, created_at, last_used_at
		   FROM passkey_credential WHERE member_id = $1 ORDER BY created_at`,
		[memberId]
	);
	return rows.map((r) => ({
		id: isoBase64URL.fromBuffer(new Uint8Array(r.id)),
		nickname: r.nickname,
		createdAt: new Date(r.created_at).toISOString(),
		lastUsedAt: r.last_used_at ? new Date(r.last_used_at).toISOString() : null
	}));
}

/** True when a row went. Scoped to the member, so one cannot remove another's. */
export async function removePasskey(memberId: string, id: string): Promise<boolean> {
	if (!isoBase64URL.isBase64URL(id) || !id) return false;
	const { rowCount } = await query(
		'DELETE FROM passkey_credential WHERE id = $1 AND member_id = $2',
		[Buffer.from(isoBase64URL.toBuffer(id)), memberId]
	);
	return (rowCount ?? 0) > 0;
}

export async function registrationOptions(
	sessionId: string,
	member: { id: string; email: string; name: string | null }
): Promise<PublicKeyCredentialCreationOptionsJSON> {
	const { rpID } = relyingParty();
	const { rows } = await query<{ id: Buffer; transports: string[] }>(
		'SELECT id, transports FROM passkey_credential WHERE member_id = $1',
		[member.id]
	);
	const options = await generateRegistrationOptions({
		rpName: site.name,
		rpID,
		userName: member.email,
		userID: new Uint8Array(userHandle(member.id)),
		userDisplayName: member.name || member.email,
		attestationType: 'none',
		excludeCredentials: rows.map((r) => ({
			id: isoBase64URL.fromBuffer(new Uint8Array(r.id)),
			transports: r.transports
		})),
		authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' }
	});
	await redis.set(
		regKey(sessionId),
		{ challenge: options.challenge, memberId: member.id },
		{ ex: CHALLENGE_TTL }
	);
	return options;
}

export type RegisterOutcome =
	| { ok: true; id: string }
	| { ok: false; reason: 'nickname' | 'challenge' | 'invalid' | 'duplicate' };

export function cleanNickname(raw: unknown): string | null {
	const nickname = typeof raw === 'string' ? raw.trim() : '';
	return nickname && nickname.length <= NICKNAME_MAX ? nickname : null;
}

export async function registerPasskey(args: {
	sessionId: string;
	memberId: string;
	nickname: unknown;
	response: RegistrationResponseJSON;
}): Promise<RegisterOutcome> {
	const nickname = cleanNickname(args.nickname);
	if (!nickname) return { ok: false, reason: 'nickname' };
	// Consumed before verifying, so a failed attempt also spends the challenge.
	const pending = (await redis.getdel(regKey(args.sessionId))) as {
		challenge: string;
		memberId: string;
	} | null;
	if (!pending || pending.memberId !== args.memberId) return { ok: false, reason: 'challenge' };

	const { rpID, origins } = relyingParty();
	let info;
	try {
		const verified = await verifyRegistrationResponse({
			response: args.response,
			expectedChallenge: pending.challenge,
			expectedOrigin: origins,
			expectedRPID: rpID,
			// 'preferred' asks for verification; the library's default demands it.
			requireUserVerification: false
		});
		if (!verified.verified) return { ok: false, reason: 'invalid' };
		info = verified.registrationInfo;
	} catch (e) {
		log.warn('auth.passkey.register-refused', { memberId: args.memberId, error: e as Error });
		return { ok: false, reason: 'invalid' };
	}

	const { credential } = info;
	const { rowCount } = await query(
		`INSERT INTO passkey_credential
		   (id, member_id, public_key, sign_count, transports, backed_up, device_type, nickname)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		 ON CONFLICT (id) DO NOTHING`,
		[
			Buffer.from(isoBase64URL.toBuffer(credential.id)),
			args.memberId,
			Buffer.from(credential.publicKey),
			credential.counter,
			credential.transports ?? [],
			info.credentialBackedUp,
			info.credentialDeviceType,
			nickname
		]
	);
	if (!rowCount) return { ok: false, reason: 'duplicate' };
	log.info('auth.passkey.registered', { memberId: args.memberId });
	return { ok: true, id: credential.id };
}

// Discoverable credentials only: the browser offers whichever passkeys it holds
// for this site, so the server never says which addresses have one.
export async function authenticationOptions(): Promise<PublicKeyCredentialRequestOptionsJSON> {
	const { rpID } = relyingParty();
	const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
	await redis.set(authKey(options.challenge), 1, { ex: CHALLENGE_TTL });
	return options;
}

export type SignInOutcome =
	| { ok: true; memberId: string; email: string }
	| { ok: false; reason: 'challenge' | 'unknown' | 'invalid' | 'sign_count' };

export async function verifyPasskeySignIn(
	response: AuthenticationResponseJSON
): Promise<SignInOutcome> {
	// With no session to key it to, the challenge keys itself: the one the
	// client signed is looked up and spent, so it verifies once at most.
	let challenge: string;
	try {
		challenge = decodeClientDataJSON(response.response.clientDataJSON).challenge;
	} catch {
		return { ok: false, reason: 'invalid' };
	}
	if (typeof challenge !== 'string' || !(await redis.getdel(authKey(challenge)))) {
		return { ok: false, reason: 'challenge' };
	}
	if (typeof response.id !== 'string' || !isoBase64URL.isBase64URL(response.id)) {
		return { ok: false, reason: 'invalid' };
	}

	const id = Buffer.from(isoBase64URL.toBuffer(response.id));
	const { rows } = await query<{
		member_id: string;
		public_key: Buffer;
		sign_count: string;
		transports: string[];
		email: string;
	}>(
		`SELECT c.member_id, c.public_key, c.sign_count, c.transports, m.email
		   FROM passkey_credential c JOIN member m ON m.id = c.member_id
		  WHERE c.id = $1`,
		[id]
	);
	const row = rows[0];
	if (!row) return { ok: false, reason: 'unknown' };
	const handle = response.response.userHandle;
	if (handle && handle !== isoBase64URL.fromBuffer(new Uint8Array(userHandle(row.member_id)))) {
		return { ok: false, reason: 'invalid' };
	}

	const stored = Number(row.sign_count);
	const { rpID, origins } = relyingParty();
	let info;
	try {
		const verified = await verifyAuthenticationResponse({
			response,
			expectedChallenge: challenge,
			expectedOrigin: origins,
			expectedRPID: rpID,
			// Counter 0 here: the library checks the counter before the signature,
			// and the regression check below must only fire on a signed response.
			credential: {
				id: response.id,
				publicKey: new Uint8Array(row.public_key),
				counter: 0,
				transports: row.transports
			},
			requireUserVerification: false
		});
		if (!verified.verified) return { ok: false, reason: 'invalid' };
		info = verified.authenticationInfo;
	} catch (e) {
		log.warn('auth.passkey.sign-in-refused', { memberId: row.member_id, error: e as Error });
		return { ok: false, reason: 'invalid' };
	}

	// An authenticator that counts never repeats or goes back. One that does is
	// a cloned key, so the assertion is refused whatever its signature says.
	const next = info.newCounter;
	if ((next > 0 || stored > 0) && next <= stored) {
		log.warn('auth.passkey.sign-count-regression', {
			memberId: row.member_id,
			stored,
			presented: next
		});
		return { ok: false, reason: 'sign_count' };
	}
	// Conditioned on the count read above, so two assertions racing with one
	// counter value cannot both land.
	const { rowCount } = await query(
		`UPDATE passkey_credential
		    SET sign_count = $2, backed_up = $3, last_used_at = now()
		  WHERE id = $1 AND sign_count = $4`,
		[id, next, info.credentialBackedUp, stored]
	);
	if (!rowCount) {
		log.warn('auth.passkey.sign-count-regression', {
			memberId: row.member_id,
			stored,
			raced: true
		});
		return { ok: false, reason: 'sign_count' };
	}
	return { ok: true, memberId: row.member_id, email: row.email };
}
