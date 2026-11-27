// invite-admin 作废（revoke）和 list 每行的 id（负责人 11-27“生产的邀请码可以查看跟废除”，弹窗选“只加作废”；架构 5.6、第 6 节 invite-admin）。
// 只测 core.ts，库由 invite-admin-fakes.ts 的假库代替（expireInvite 和 index.ts 同一个比较并交换的条件）；
// 作废以后 invite-signup 不认：invite-admin-e2e.test.ts；真库：supabase/tests/store-it/invite-admin-store.it.ts。
import { describe, expect, it } from 'vitest';
import { handle, inviteIdOf, REVOKED_EXPIRES_AT } from '../../supabase/functions/invite-admin/core.ts';
import { inviteCodeHash } from '../../supabase/functions/_shared/invite-code.ts';
import { ADMIN, call, deps, FakeStore, NOW, req, USER } from './invite-admin-fakes.ts';

describe('list 的 id', () => {
  it('id：code_hash 前 8 位；同一份里前 8 位撞了的几行改用前 16 位，没撞的照旧 8 位', () => {
    const a = `abcdef01${'1'.repeat(56)}`;
    const b = `abcdef01${'2'.repeat(56)}`;
    const c = `12345678${'3'.repeat(56)}`;
    expect([a, c, b].map(inviteIdOf([a, c, b]))).toEqual([a.slice(0, 16), '12345678', b.slice(0, 16)]);
    expect(inviteIdOf([])(c)).toBe('12345678');
  });

  it('list 回 code_hash 前 8 位作 id，完整的 code_hash 不出函数', async () => {
    const store = new FakeStore();
    await call(store, { action: 'create', note: 'a' });
    const h = [...store.invites.keys()][0] ?? '';
    const { res } = await call(store, { action: 'list' });
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ invites: [expect.objectContaining({ id: h.slice(0, 8), note: 'a' })] });
    expect(text).not.toContain(h);
  });
});

describe('invite-admin revoke（负责人 11-27“生产的邀请码可以查看跟废除”：只加作废）', () => {
  /** 发一个码，回 {code, id}：id 从 list 里拿（同前端） */
  async function issue(store: FakeStore, note: string, user = ADMIN): Promise<{ code: string; id: string }> {
    const { res } = await call(store, { action: 'create', note }, { user });
    const { code } = (await res.json()) as { code: string };
    const l = await call(store, { action: 'list' }, { user });
    const rows = ((await l.res.json()) as { invites: { id: string; note: string }[] }).invites;
    return { code, id: rows.find((r) => r.note === note)?.id ?? '' };
  }

  it('作废还没用的码：200 {ok}，expires_at 改成 1970-01-01，list 里不再有它；不计次数、日志不记东西', async () => {
    const store = new FakeStore();
    const { code, id } = await issue(store, '11-27 #1');
    await issue(store, '11-27 #2');
    expect(id).toMatch(/^[0-9a-f]{8}$/);
    const before = new Map(store.counters);
    const { res, logs } = await call(store, { action: 'revoke', id });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(store.invites.get(await inviteCodeHash(code))?.expires_at).toBe(REVOKED_EXPIRES_AT);
    expect(REVOKED_EXPIRES_AT).toBe('1970-01-01T00:00:00.000Z');
    const l = await call(store, { action: 'list' });
    expect(((await l.res.json()) as { invites: { note: string }[] }).invites.map((r) => r.note)).toEqual(['11-27 #2']);
    expect(store.counters).toEqual(before);
    expect(logs).toEqual([]);
    // 再作废一次：已经作废（等于过期）回 404 not_found
    const again = await call(store, { action: 'revoke', id });
    expect(again.res.status).toBe(404);
    expect(await again.res.json()).toEqual({ error: 'not_found' });
  });

  it('已用掉的、已过期的、别人发的、没有这个前缀的：一律 404 not_found，库不动', async () => {
    const store = new FakeStore();
    store.admins.add(USER);
    const used = await issue(store, 'used');
    const row = store.invites.get(await inviteCodeHash(used.code));
    if (row) row.used_count = 1;
    const other = await issue(store, 'other', USER);
    store.invites.set('dead', { code_hash: `deadbeef${'0'.repeat(56)}`, created_by: ADMIN, max_uses: 1, used_count: 0, expires_at: new Date(NOW - 1000).toISOString(), note: 'expired' });
    const snapshot = JSON.stringify([...store.invites.values()]);
    for (const id of [used.id, other.id, 'deadbeef', '00000000']) {
      const { res } = await call(store, { action: 'revoke', id });
      expect(res.status, id).toBe(404);
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
    expect(JSON.stringify([...store.invites.values()])).toBe(snapshot);
  });

  it('前缀认不准（同一个前缀找到 2 行，含一行已用完的）：not_found，两行都不动；给 16 位就能作废其中没用的那一行', async () => {
    const store = new FakeStore();
    const a = `abcdef01${'1'.repeat(56)}`;
    const b = `abcdef01${'2'.repeat(56)}`;
    const exp = new Date(NOW + 86400_000).toISOString();
    store.invites.set(a, { code_hash: a, created_by: ADMIN, max_uses: 1, used_count: 0, expires_at: exp, note: 'a' });
    store.invites.set(b, { code_hash: b, created_by: ADMIN, max_uses: 1, used_count: 1, expires_at: exp, note: 'b' });
    const l = await call(store, { action: 'list' });
    expect(((await l.res.json()) as { invites: { id: string }[] }).invites.map((r) => r.id).sort()).toEqual([a.slice(0, 16), b.slice(0, 16)].sort());
    const short = await call(store, { action: 'revoke', id: 'abcdef01' });
    expect(short.res.status).toBe(404);
    expect(store.invites.get(a)?.expires_at).toBe(exp);
    expect(store.invites.get(b)?.expires_at).toBe(exp);
    expect((await call(store, { action: 'revoke', id: b.slice(0, 16) })).res.status).toBe(404);   // 已用完
    expect((await call(store, { action: 'revoke', id: a.slice(0, 16) })).res.status).toBe(200);
    expect(store.invites.get(a)?.expires_at).toBe(REVOKED_EXPIRES_AT);
  });

  it('找到以后、改之前码刚好被人占上（比较并交换没对上）：not_found，不作废', async () => {
    const store = new FakeStore();
    const { code, id } = await issue(store, 'race');
    const h = await inviteCodeHash(code);
    const find = store.findLiveInvites.bind(store);
    store.findLiveInvites = async (...args) => {
      const rows = await find(...args);
      const r = store.invites.get(h);
      if (r) r.used_count = 1;   // invite_claim 抢先提交
      return rows;
    };
    const { res } = await call(store, { action: 'revoke', id });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect(store.invites.get(h)?.expires_at).not.toBe(REVOKED_EXPIRES_AT);
  });

  it('id 不是 8 或 16 位小写十六进制（含 like 通配符、大写、完整哈希、不是字符串）：400 bad_request，不查库', async () => {
    const store = new FakeStore();
    store.calls = [];
    for (const id of [undefined, 123, '', 'abc', 'ABCDEF01', 'abcdef0%', 'abcdef0_', 'abcdef01a', 'g'.repeat(8), 'a'.repeat(64)]) {
      const { res } = await call(store, { action: 'revoke', ...(id === undefined ? {} : { id }) });
      expect(res.status, String(id)).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
    expect(store.calls.filter((c) => c !== 'isAdmin' && c !== 'minClientVersion')).toEqual([]);
  });

  it('非管理员 revoke 403 not_admin，不读请求体、不查 invites', async () => {
    const store = new FakeStore();
    const r = req({ action: 'revoke', id: 'abcdef01' });
    const res = await handle(r, deps(store, { user: USER }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_admin' });
    expect(r.bodyUsed).toBe(false);
    expect(store.calls).toEqual(['isAdmin']);
  });

  it('数据库出错回 503 try_later，日志只记 db_error', async () => {
    const store = new FakeStore();
    store.expireInvite = async () => { throw new Error('connection to db.xxx failed'); };
    const { id } = await issue(store, 'x');
    const { res, logs } = await call(store, { action: 'revoke', id });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'try_later' });
    expect(logs).toEqual(['db_error']);
  });
});
