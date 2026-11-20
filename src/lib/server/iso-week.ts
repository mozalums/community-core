// ISO-week-year + ISO-week formatted as YYYYWW. Matches the `RRRRII`
// output of date-fns used by other loremlabs properties so cohorts line
// up across sites in analytics. Lifted out of hooks.server.ts so other
// server modules (layout loader, future analytics jobs) can reuse it.

export function isoWeekCohort(d = new Date()): string {
	const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
	const day = t.getUTCDay() || 7;
	t.setUTCDate(t.getUTCDate() + 4 - day);
	const year = t.getUTCFullYear();
	const yearStart = new Date(Date.UTC(year, 0, 1));
	const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
	return `${year}${String(week).padStart(2, '0')}`;
}
