// Runs on the every-role field set: what is under test is bound to the field
// schema when its module loads, and the default skin declares no affiliation
// and no public-profile field. The mock has to precede every application
// import, so those are dynamic.
import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { EVERY_ROLE_FIELDS, fieldSchemaWith } from '$lib/server/field-schema-fake';

mock.module('$lib/server/field-schema', { namedExports: fieldSchemaWith(EVERY_ROLE_FIELDS) });

const { fieldByRole, fieldsWithRole } = await import('../../server/field-schema');
const { AFFILIATIONS, OTHER_AFFILIATION_KEY, PUBLIC_PROFILE_KEY, HAS_AFFILIATIONS } =
	await import('../../server/affiliations');

test('R2: affiliations are the fields whose role says so', () => {
	assert.deepEqual(
		AFFILIATIONS,
		fieldsWithRole('affiliation').map((f) => ({ key: f.key, label: f.label }))
	);
	assert.deepEqual(
		AFFILIATIONS.map((a) => a.key),
		['staff', 'volunteer']
	);
	assert.equal(OTHER_AFFILIATION_KEY, fieldByRole('affiliationOther').key);
	assert.equal(PUBLIC_PROFILE_KEY, fieldByRole('publicProfile').key);
	assert.equal(HAS_AFFILIATIONS, true);
});
