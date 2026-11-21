import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = (p: string) => pathToFileURL(resolve(p)).href;
const group = { id: 'g', slug: 'example', name: 'Example' };
const member = { id: '00000000-0000-4000-8000-000000000001', email: 'a@example.org', identSubject: 'email:a@example.org', data: {}, privateData: {} };
let failure = '';
let avatarPresent = true;
let sessions = new Set(['this-session', 'other-session']);
let purged = false;
mock.module('$lib/server/groups', { namedExports: {
  getGroupBySlug: async () => group, resolveGroupAdmin: async () => false
}});
mock.module('$lib/server/members', { namedExports: {
  getMemberById: async () => member, canEditMember: () => true
}});
mock.module('$lib/server/postgres', { namedExports: {
  query: async () => ({ rows: [], rowCount: 0 }),
  withTransaction: async (fn: any) => fn({ query: async (sql: string) => {
    if (/DELETE FROM member WHERE/.test(sql)) {
      purged = true;
      return { rows: [{ email: member.email, ident_subject: member.identSubject }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }})
}});
mock.module('$lib/server/avatars', { namedExports: {
  avatarIdFor: async () => 'photo',
  deleteAvatar: async () => {
    if (failure === 'avatar') throw new Error('avatar storage unavailable');
    avatarPresent = false;
  }
}});
mock.module('$lib/server/gravatar', { namedExports: { gravatarHash: () => 'hash' } });
mock.module('$lib/server/session-store', { namedExports: {
  SESSION_COOKIE_NAME: 'sid', SESSION_COOKIE_OPTIONS: {},
  deleteUserSessions: async () => {
    if (failure === 'sessions') throw new Error('redis unavailable');
    sessions.clear();
  },
  deleteSession: async (sid: string) => {
    if (failure === 'sessions') throw new Error('redis unavailable');
    sessions.delete(sid);
  }
}});
mock.module('$lib/server/log', { namedExports: { log: { debug() {}, info() {}, warn() {}, error() {} } } });
const { actions } = await import(source('src/routes/group/[slug]/members/[id]/edit/+page.server.ts'));

for (const mode of ['', 'avatar', 'sessions']) {
  test(`E32 R6: removal never reports completion with retained ${mode || 'data'}`, async () => {
    failure = mode; avatarPresent = true; sessions = new Set(['this-session', 'other-session']); purged = false;
    let outcome: any;
    try {
      outcome = await actions.delete({ params: { slug: group.slug, id: member.id },
        locals: { user: { subject: member.identSubject, email: member.email } },
        cookies: { get: () => 'this-session', delete() {} },
        url: new URL(`https://example.org/members/${member.id}/edit`) });
    } catch (e) { outcome = e; }
    const state = { status: outcome?.status, purged, avatarPresent, sessions: [...sessions] };
    console.log(JSON.stringify(state));
    if (outcome?.status === 303) {
      assert.equal(avatarPresent, false, 'success redirect left the photo publicly retrievable');
      assert.equal(sessions.size, 0, 'success redirect left sessions valid');
    } else {
      assert.ok(outcome?.status >= 400, 'failed cleanup needs a visible failure');
    }
  });
}
