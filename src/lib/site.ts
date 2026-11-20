// Brand + site constants. Used by /legal/* and any other static copy that
// needs to know the company name / domain / contact email. Keep this tiny
// — if it grows past ~10 keys we should split it by concern.
//
// The deployment's apex domain is configurable via PUBLIC_BASE_DOMAIN so the
// app can run under another hostname without code edits. Everything
// host-derived — session-cookie scope, the canonical www host/URL, brand name,
// contact addresses — flows from it. Universal module: dynamic *public* env is
// readable on both server and client.
//
// The fallback is the skin's `site.domain`, the domain that community is
// served on. A fallback naming any other domain scopes the session cookie to
// that domain, the browser drops the cookie it is handed, and the symptom is
// "sign-in doesn't stick" rather than anything that reads as a configuration
// error.

import { env } from '$env/dynamic/public';
import { site } from '$skin/skin.yaml';

export const APP_APEX_DOMAIN = env.PUBLIC_BASE_DOMAIN || site.domain;
export const APP_BASE_DOMAIN = `www.${APP_APEX_DOMAIN}`;
export const APP_BASE_URL = `https://${APP_BASE_DOMAIN}`;

// Brand vs. operating entity: COMPANY_NAME is what users see (the product
// brand, today the bare domain). COMPANY_LEGAL_NAME is who operates the site,
// for legal copy, and comes from the skin's `site.legal_name`. Nothing renders
// it yet, since /legal/* does not exist in this tree.
export const COMPANY_NAME = APP_APEX_DOMAIN;
export const COMPANY_SHORT = APP_APEX_DOMAIN;
export const COMPANY_LEGAL_NAME = site.legal_name;

// Same address handles both privacy inquiries and general support today.
// Split if/when those flows diverge (separate inboxes, separate routing).
export const COMPANY_PRIVACY_EMAIL = `hello@${APP_APEX_DOMAIN}`;
export const COMPANY_SUPPORT_EMAIL = `hello@${APP_APEX_DOMAIN}`;
