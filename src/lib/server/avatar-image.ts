// Uploaded photos are decoded and re-encoded before they are stored, so what
// /avatar/<id> serves from our origin is pixels we produced rather than bytes a
// caller chose. The declared type is a claim made by the client; it is checked
// against the file's signature and then against what the decoder found, and a
// disagreement at either step is a refusal rather than a correction. Trusting
// the sniff instead would let a mislabeled file through under whichever label a
// later check happens to read.
//
// Re-encoding is also what strips EXIF. These are photographs of people, and a
// phone photo carries the GPS position it was taken at.

import sharp from 'sharp';

export type AvatarType = 'image/jpeg' | 'image/png' | 'image/webp';

/** Longest edge after normalization. The largest render is a profile header. */
export const MAX_AVATAR_EDGE = 1024;

// A 2 MB PNG of one flat color can declare dimensions that decode to gigabytes.
// 50 MP clears a full-resolution phone photo and refuses the bomb before the
// decoder allocates for it.
const MAX_INPUT_PIXELS = 50_000_000;

const FORMAT_TYPE: Record<string, AvatarType> = {
	jpeg: 'image/jpeg',
	png: 'image/png',
	webp: 'image/webp'
};

/** The image type the leading bytes carry, or null for anything else. */
export function sniffImageType(bytes: Uint8Array): AvatarType | null {
	const at = (offset: number, sig: number[]) => sig.every((b, i) => bytes[offset + i] === b);
	if (at(0, [0xff, 0xd8, 0xff])) return 'image/jpeg';
	if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
	// RIFF, a 4-byte length, then WEBP.
	if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'image/webp';
	return null;
}

export type NormalizedAvatar =
	| { ok: true; bytes: Buffer; contentType: AvatarType }
	| { ok: false; error: string };

export async function normalizeAvatar(
	bytes: Buffer,
	declared: string,
	maxBytes: number
): Promise<NormalizedAvatar> {
	const mismatch = { ok: false, error: 'The file is not the image type it claims to be.' } as const;
	// The signature gate runs before the decoder, so libvips only ever sees bytes
	// that already claim to be one of three formats. It decodes many more.
	const sniffed = sniffImageType(bytes);
	if (!sniffed || sniffed !== declared) return mismatch;

	let out: Buffer;
	try {
		const image = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' });
		const meta = await image.metadata();
		if (FORMAT_TYPE[meta.format] !== sniffed) return mismatch;
		// autoOrient applies the EXIF rotation to the pixels; the metadata that
		// carried it is dropped on output with the rest of EXIF.
		const pipeline = image
			.autoOrient()
			.resize(MAX_AVATAR_EDGE, MAX_AVATAR_EDGE, { fit: 'inside', withoutEnlargement: true });
		const encoded =
			sniffed === 'image/jpeg'
				? pipeline.jpeg({ quality: 85, mozjpeg: true })
				: sniffed === 'image/png'
					? pipeline.png({ compressionLevel: 9 })
					: pipeline.webp({ quality: 85 });
		out = await encoded.toBuffer();
	} catch {
		return { ok: false, error: 'The image could not be read. Try saving it again as a JPEG.' };
	}
	if (out.length > maxBytes) {
		return { ok: false, error: 'Image must be 2 MB or smaller.' };
	}
	return { ok: true, bytes: out, contentType: sniffed };
}
