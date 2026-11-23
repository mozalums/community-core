// Dev seed: the skin's default group + a handful of invented sample members +
// the superadmin (from ADMIN_SUBJECTS) as a group_admin. Idempotent —
// re-running upserts. Usage: pnpm seed
import { migrateGated } from '../src/lib/server/migrations';
import { currentSkin } from '../src/lib/skin/load';
import { scriptPool } from './db';

const pool = scriptPool();

const SAMPLE_MEMBERS = [
	{
		email: 'ada@example.org',
		name: 'Ada Example',
		city: 'San Francisco',
		links: [{ site: 'linkedin', handle: 'example-ada' }]
	},
	{
		email: 'bruno@example.org',
		name: 'Bruno Sample',
		city: 'Berlin',
		links: [{ site: 'linkedin', handle: 'example-bruno' }]
	},
	{
		email: 'chen@example.org',
		name: 'Chen Placeholder',
		city: 'Toronto',
		links: [{ site: 'linkedin', handle: 'example-chen' }]
	},
	{
		email: 'dara@example.org',
		name: 'Dara Fixture',
		city: 'San Francisco',
		links: [{ site: 'linkedin', handle: 'example-dara' }]
	},
	{
		email: 'eli@example.org',
		name: 'Eli Testcase',
		city: 'Boston',
		links: [{ site: 'linkedin', handle: 'example-eli' }]
	}
];

// Under the skin's links field, when it has one.
function linksData(links: { site: string; handle: string }[]): Record<string, unknown> {
	const field = currentSkin().skin.fields.find((f) => f.type === 'links');
	return field ? { [field.key]: links } : {};
}

async function main() {
	await migrateGated(pool, process.env.LOREM_WRITERS_STOPPED);

	const { site } = currentSkin().skin;
	const landingMd = [`# ${site.name}`, '', "A place to see what's happening here.", ''].join('\n');

	const g = await pool.query<{ id: string }>(
		`INSERT INTO "group" (slug, name, landing_md)
		   VALUES ($1, $2, $3)
		 ON CONFLICT (slug) DO UPDATE SET
		   name = EXCLUDED.name,
		   -- don't clobber an admin-edited landing page on re-seed
		   landing_md = COALESCE("group".landing_md, EXCLUDED.landing_md),
		   updated_at = now()
		 RETURNING id`,
		[site.default_group, site.name, landingMd]
	);
	const groupId = g.rows[0].id;
	console.log(`group ${site.default_group}: ${groupId}`);

	for (const m of SAMPLE_MEMBERS) {
		await pool.query(
			`INSERT INTO member (group_id, email, name, city, data)
			   VALUES ($1, $2, $3, $4, $5::jsonb)
			 ON CONFLICT (group_id, email) DO UPDATE
			   SET name = EXCLUDED.name, city = EXCLUDED.city,
			       data = member.data || EXCLUDED.data, status = 'active'`,
			[groupId, m.email, m.name, m.city, JSON.stringify(linksData(m.links))]
		);
	}
	console.log(`members upserted: ${SAMPLE_MEMBERS.length}`);

	const admins = (process.env.ADMIN_SUBJECTS ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	for (const subject of admins) {
		await pool.query(
			`INSERT INTO group_admin (group_id, ident_subject)
			   VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			[groupId, subject]
		);
	}
	console.log(
		admins.length
			? `group_admin seeded: ${admins.join(', ')}`
			: 'group_admin: none (ADMIN_SUBJECTS empty) — superadmin still works via env'
	);
}

main()
	.then(async () => {
		await pool.end();
		process.exit(0);
	})
	.catch(async (e) => {
		console.error('[seed] failed:', e);
		await pool.end().catch(() => {});
		process.exit(1);
	});
