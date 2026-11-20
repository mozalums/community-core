// "Associated with": the affiliation checkboxes, the free-text "Other" and the
// public-profile opt-in, found by role in the field schema. Used by the
// membership-request flow (requests.ts) and profile editing (member-edit.ts).

import { fieldsWithRole, isChecked, optionalFieldByRole } from '$lib/server/field-schema';
import { ROLE_CONTROLS } from '$lib/skin/schema';

export { isChecked };

export const AFFILIATIONS: { key: string; label: string }[] = fieldsWithRole('affiliation').map(
	(f) => ({ key: f.key, label: f.label })
);

// Undefined when the skin declares no such field: there is then no "Other"
// to fill in, and no member can opt in to the public showcase.
export const OTHER_AFFILIATION_KEY = optionalFieldByRole('affiliationOther')?.key;

export const PUBLIC_PROFILE_KEY = optionalFieldByRole('publicProfile')?.key;

// The names the forms post those two under, whatever the skin keys them by.
export const OTHER_AFFILIATION_CONTROL = ROLE_CONTROLS.affiliationOther;
export const PUBLIC_PROFILE_CONTROL = ROLE_CONTROLS.publicProfile;
// An affiliation box posts as this and its field's key.
export const AFFILIATION_CONTROL_PREFIX = 'aff_';

// Whether the skin gives a requester anything to be associated with.
export const HAS_AFFILIATIONS = AFFILIATIONS.length > 0 || OTHER_AFFILIATION_KEY !== undefined;
