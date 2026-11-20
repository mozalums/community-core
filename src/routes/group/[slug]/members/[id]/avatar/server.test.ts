import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import sharp from 'sharp';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

// The upload endpoint against the real decoder: only Postgres and the member
// write are stubbed, so what putAvatar receives here is what the table would
// hold and what /avatar/<id> would serve.

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

const GROUP = { id: '00000000-0000-4000-8000-000000000001', slug: 'example', name: 'Example' };
const ID = '00000000-0000-4000-8000-0000000000aa';
const ADA = { id: 'u', email: 'ada@example.org', subject: 'oidc:ada', name: 'Ada', image: '' };
const MEMBER = { id: ID, groupId: GROUP.id, email: 'ada@example.org', identSubject: 'oidc:ada' };
const PUBLIC_ID = '3f6b1a2c-9d84-4c1e-8f37-6b2ad5c90e11';

let stored: { bytes: Buffer; contentType: string }[] = [];
let written: Record<string, string>[] = [];

mock.module('$lib/server/groups', {
	namedExports: { getGroupBySlug: async () => GROUP, resolveGroupAdmin: async () => false }
});
mock.module('$lib/server/members', {
	namedExports: {
		getMemberById: async () => structuredClone(MEMBER),
		canEditMember: () => true
	}
});
mock.module('$lib/server/avatars', {
	namedExports: {
		putAvatar: async (_email: string, bytes: Buffer, contentType: string) => {
			stored.push({ bytes, contentType });
			return PUBLIC_ID;
		},
		deleteAvatar: async () => {},
		ACCEPTED_TYPES: ['image/jpeg', 'image/png', 'image/webp'],
		MAX_AVATAR_BYTES: 2 * 1024 * 1024
	}
});
mock.module('$lib/server/member-write', {
	namedExports: {
		updateMember: async (_g: unknown, _id: string, fields: Record<string, string>) => {
			written.push(fields);
			return 1;
		}
	}
});
mock.module('$lib/server/audit-core', { namedExports: { actorOf: () => 'member:u' } });
mock.module('$lib/server/log', {
	namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } }
});

const { POST } = await import('./+server');
const { MAX_AVATAR_EDGE } = await import('$lib/server/avatar-image');

const url = new URL(`https://dir.example.org/group/example/members/${ID}/avatar`);

async function upload(bytes: Uint8Array, type: string): Promise<Response> {
	const body = new FormData();
	body.append('photo', new File([new Uint8Array(bytes)], 'photo', { type }));
	const request = new Request(url, { method: 'POST', body });
	return POST({
		params: { slug: 'example', id: ID },
		locals: { user: ADA },
		request,
		url
	} as never);
}

function solid(width: number, height: number) {
	return sharp({
		create: { width, height, channels: 3, background: { r: 200, g: 80, b: 40 } }
	});
}

beforeEach(() => {
	stored = [];
	written = [];
});

test('B22.4: bytes that are not a PNG, declared image/png, are refused with a 400', async () => {
	const html = new TextEncoder().encode('<html><script>alert(document.domain)</script></html>');
	const res = await upload(html, 'image/png');
	assert.equal(res.status, 400);
	assert.equal(stored.length, 0, 'the bytes reached the table');
	assert.equal(written.length, 0, 'a photo URL was recorded for a refused upload');
});

test('B22.1: a real JPEG declared as image/png is refused, not relabeled', async () => {
	const jpeg = await solid(8, 8).jpeg().toBuffer();
	const res = await upload(jpeg, 'image/png');
	assert.equal(res.status, 400);
	assert.match((await res.json()).error, /not the image type it claims/);
	assert.equal(stored.length, 0);
});

test('B22.1: a PNG signature over bytes the decoder cannot read is refused', async () => {
	const png = await solid(8, 8).png().toBuffer();
	const truncated = png.subarray(0, 24);
	const res = await upload(truncated, 'image/png');
	assert.equal(res.status, 400);
	assert.equal(stored.length, 0);
});

test('B22.2: the stored photo is re-encoded, oriented, size-capped and stripped of EXIF', async () => {
	// Orientation 6 is "rotate 90 clockwise to display", so a 2000x1000 sensor
	// image is a portrait photo. GPS sits in IFD3.
	const photo = await solid(2000, 1000)
		.jpeg()
		.withMetadata({ orientation: 6 })
		.withExif({
			IFD0: { Make: 'PhoneCo' },
			IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' }
		})
		.toBuffer();
	const before = await sharp(photo).metadata();
	assert.ok(before.exif && before.orientation === 6, 'fixture carries no EXIF orientation');

	const res = await upload(photo, 'image/jpeg');
	assert.equal(res.status, 200);
	assert.equal(stored.length, 1);
	const { bytes, contentType } = stored[0];
	assert.equal(contentType, 'image/jpeg');
	assert.notDeepEqual(bytes, photo);

	const meta = await sharp(bytes).metadata();
	assert.equal(meta.format, 'jpeg');
	assert.equal(meta.exif, undefined, 'EXIF survived the re-encode');
	assert.ok(!bytes.includes(Buffer.from('PhoneCo')), 'camera make survived');
	assert.equal(meta.orientation, undefined);
	assert.equal(meta.height, MAX_AVATAR_EDGE, 'portrait not applied or not capped');
	assert.equal(meta.width, MAX_AVATAR_EDGE / 2);
});

test('B22.2: a small PNG and a WebP keep their format and are not enlarged', async () => {
	for (const [type, image] of [
		['image/png', solid(40, 30).png()],
		['image/webp', solid(40, 30).webp()]
	] as const) {
		stored = [];
		const res = await upload(await image.toBuffer(), type);
		assert.equal(res.status, 200, type);
		assert.equal(stored[0].contentType, type);
		const meta = await sharp(stored[0].bytes).metadata();
		assert.equal(`image/${meta.format}`, type);
		assert.deepEqual([meta.width, meta.height], [40, 30]);
	}
});

test('B22.3: the re-encoded upload records the URL of the public id putAvatar returned', async () => {
	const original = await solid(64, 64).png({ compressionLevel: 0 }).toBuffer();
	const first = await upload(original, 'image/png');
	const second = await upload(await solid(32, 32).jpeg().toBuffer(), 'image/jpeg');
	assert.notDeepEqual(
		stored[0].bytes,
		original,
		'the stored bytes are the upload, not a re-encode'
	);
	assert.equal(first.status, 200);
	assert.equal(second.status, 200);
	const expected = `https://dir.example.org/avatar/${PUBLIC_ID}`;
	assert.deepEqual(written, [{ photo: expected }, { photo: expected }]);
	assert.deepEqual(
		stored.map((s) => s.contentType),
		['image/png', 'image/jpeg']
	);
});
