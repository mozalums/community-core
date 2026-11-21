import assert from 'node:assert/strict';
import { after, before, mock, test } from 'node:test';
import { HISTORICAL_KEY_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(HISTORICAL_KEY_FIELDS.map((f) => f.key === 'startYear' ? { ...f, filter: 'exact' } : f)) });

const url = process.env.AUDIT_TEST_DATABASE_URL;
const opts = { skip: url ? false : 'AUDIT_TEST_DATABASE_URL unset' };
const { default: pg } = await import('pg');
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : null;
const GROUP = { id: '', slug: 'f13-review-single-column', name: 'F13 single-column filter', landingMd: null, status: 'active' };

mock.module('$lib/server/postgres', {
    namedExports: {
        query: (text: string, values?: unknown[]) => pool!.query(text, values),
        withTransaction: async () => assert.fail('search writes nothing')
    }
});
mock.module('$lib/server/groups', {
    namedExports: { getGroupBySlug: async () => GROUP, resolveGroupAdmin: async () => false }
});
mock.module('$lib/server/avatars', {
    namedExports: {
        emailMd5: (s: string) => s,
        ensureAvatarRows: async () => new Map(),
        avatarIdsByEmailMd5: async () => new Map()
    }
});
mock.module('$lib/server/stars', {
    namedExports: { getStarredIds: async () => new Set<string>() }
});

const { migrate } = await import('./migrations');
const { load } = await import('../../routes/group/[slug]/members/+page.server');
type Directory = { members: { name: string | null }[]; filters: { label: string; value: string; without: string }[] };

before(async () => {
    if (!pool) return;
    await migrate(pool);
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO "group" (slug, name) VALUES ($1, $2) RETURNING id`,
        [GROUP.slug, GROUP.name]
    );
    GROUP.id = rows[0].id;
    await pool.query(
        `INSERT INTO member (group_id, email, name, data, status) VALUES ($1, $2, $3, $4::jsonb, 'active')`,
        [GROUP.id, 'single-column@example.org', 'Promoted Name', { startYear: 'Stored Name' }]
    );
});
after(async () => {
    if (!pool) return;
    await pool.query('DELETE FROM member WHERE group_id = $1', [GROUP.id]);
    await pool.query('DELETE FROM "group" WHERE id = $1', [GROUP.id]);
    await pool.end();
});

async function names(value: string) {
    const out = await load({
        params: { slug: GROUP.slug },
        url: new URL(`https://example.org/group/${GROUP.slug}/members?startYear=${encodeURIComponent(value)}`),
        parent: async () => ({}),
        locals: { user: null }
    } as unknown as Parameters<typeof load>[0]) as Directory;
    return out.members.map((m) => m.name);
}

test('F13 review R2: a non-city filter reads data even when it alone feeds a promoted column', opts, async () => {
    // This fixture assigns role name and column name to the key startYear.
    // Field keys cannot decide either the role or the storage source.
    assert.deepEqual(
        { stored: await names('Stored Name'), promoted: await names('Promoted Name') },
        { stored: ['Promoted Name'], promoted: [] }
    );
});
