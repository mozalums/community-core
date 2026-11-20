// See https://svelte.dev/docs/kit/types#app
import type { SessionData, SessionUser } from '$lib/server/session-store';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			sessionId: string | null;
			session: SessionData | null;
			user: SessionUser | null;
			marketing: {
				cohort: string;
				utm: Record<string, string>;
			};
		}
		interface PageData {
			// Signed-in identity (from the magic-link session), or null.
			user: SessionUser | null;
		}
		// interface PageState {}
		interface Platform {
			// adapter-node passes the raw Node request through. `clientAddress`
			// reads the TCP peer off its socket, which is the only address left
			// when ADDRESS_HEADER is set and the proxy did not send the header.
			req?: import('node:http').IncomingMessage;
		}
	}
}

export {};
