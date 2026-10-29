// invite-admin 的单元测试（架构 5.6 发码、第 6 节函数表 invite-admin、15.4 S-B1；R-83）：TC-B1-01、TC-B1-70 的函数一半。
// 只测 core.ts（index.ts 只是把 supabase-js、requireActiveUser 接上），数据库和鉴权由假对象代替（invite-admin-fakes.ts）。
// 数据库一半：supabase/tests/rls/04_config_constraints.test.sql（TC-B1-70）；真 store：supabase/tests/store-it/invite-admin-store.it.ts；
// 端到端（交给 invite-signup）：invite-admin-e2e.test.ts。
import { describe, expect, it } from 'vitest';
import { handle, INVITE_ADMIN_ERRS, INVITE_DAILY_LIMIT, INVITE_MAX_USES, INVITE_TTL_S, keys, NOTE_MAX, parseNote } from '../../supabase/functions/invite-admin/core.ts';
import { INVITE_ALPHABET, inviteCodeHash, isInviteCode, randomInviteCode } from '../../supabase/functions/_shared/invite-code.ts';
import { INVITE_ADMIN_ERROR_CODES, INVITE_NOTE_MAX, inviteAdminErrorCode } from '../../shared/schema/invite-admin.ts';
import { ADMIN, call, COUNTER_KEY, deps, FakeStore, NOW, req, USER } from './invite-admin-fakes.ts';

describe('邀请码生成（_shared/invite-code.ts）', () => {
  it('12 位、只用 32 个字符的字母表，过得了 invite-signup 的格式校验', () => {
    for (let i = 0; i < 200; i++) {
      const c = randomInviteCode();
      expect(c).toHaveLength(12);
      expect(isInviteCode(c), c).toBe(true);
    }
  });

  it('每个字节只取低 5 位：正好喂 0～255 共 256 个字节，32 个字符每个正好 8 次', () => {
    // 字节流 0、1、2……依次填进每次调用的 12 字节缓冲；输出第 i 个字符只取决于第 i 个字节，取前 256 个字符就是 0～255 各一次
    let next = 0;
    let out = '';
    while (out.length < 256) out += randomInviteCode((b) => { for (let i = 0; i < b.length; i++) b[i] = next++ & 255; });
    const counts = new Map<string, number>();
    for (const ch of out.slice(0, 256)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect([...counts.keys()].sort().join('')).toBe([...INVITE_ALPHABET].sort().join(''));
    for (const [ch, n] of counts) expect(n, ch).toBe(8);
  });
});

describe('计数键、备注', () => {
  it('计数键过得了 counters 的 check 约束（invite-admin:<user_id>:<UTC 日期>）', () => {
    expect(keys.create(ADMIN, NOW)).toBe(`invite-admin:${ADMIN}:20261029`);
    expect(keys.create(ADMIN, NOW)).toMatch(COUNTER_KEY);
  });

  it('备注：去首尾空白、空的当没写、按码点数（和 char_length 一致），超过 40 个字符 too_long', () => {
    expect(NOTE_MAX).toBe(INVITE_NOTE_MAX);
    expect(parseNote(undefined)).toBeNull();
    expect(parseNote(null)).toBeNull();
    expect(parseNote('   ')).toBeNull();
    expect(parseNote(' 10-29 #3 ')).toBe('10-29 #3');
    expect(parseNote('一'.repeat(40))).toBe('一'.repeat(40));
    expect(parseNote('一'.repeat(41))).toBe('too_long');
    expect(parseNote('😀'.repeat(40))).toBe('😀'.repeat(40));   // 40 个码点（UTF-16 是 80 个单元），char_length = 40
    expect(parseNote('😀'.repeat(41))).toBe('too_long');
    for (const bad of [1, true, ['a'], { a: 1 }]) expect(parseNote(bad), JSON.stringify(bad)).toBe('bad');
  });

  it('安全审查必改 2：U+0000、C0 控制字符（含换行、制表）、DEL、C1、孤立代理项、双向覆盖字符、零宽字符、方向标记、行段分隔符一律 bad', () => {
    const bads = [
      'a\u0000b', '\u0000', 'a\u0001', 'a\nb', 'a\tb', 'a\rb', 'a\u001fb', 'a\u007fb', 'a\u0085b', 'a\u009fb',
      'a\ud800b', 'a\udc00b', '\ud83d', 'x\ude00', '\ude00\ud83d',
      'a\u202ab', 'a\u202bb', 'a\u202cb', 'a\u202db', 'a\u202eb', 'a\u2066b', 'a\u2067b', 'a\u2068b', 'a\u2069b',
      'a\u200bb', 'a\u200cb', 'a\u200db', 'a\u200eb', 'a\u200fb', 'a\u061cb', 'a\u2028b', 'a\u2029b',
      '\n10-29',   // 首尾的换行也算：在去空白之前判断
    ];
    for (const b of bads) expect(parseNote(b), JSON.stringify(b)).toBe('bad');
    // 合法的代理对（emoji）、普通空格、全角空格、韩文照常
    for (const ok of ['😀', '10-29 #1', 'a\u3000b', '첫 번째']) expect(parseNote(ok), JSON.stringify(ok)).toBe(ok);
  });
});

describe('invite-admin create（TC-B1-01：只有管理员发码，只存哈希）', () => {
  it('TC-B1-01：非管理员回 403 not_admin，不读配置、不计次数、不写库', async () => {
    const store = new FakeStore();
    const { res } = await call(store, { action: 'create', note: '10-29' }, { user: USER });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_admin' });
    expect(store.invites.size).toBe(0);
    expect(store.counters.size).toBe(0);
    expect(store.calls).toEqual(['isAdmin']);
  });

  it('TC-B1-01：非管理员 list 同样 403', async () => {
    const store = new FakeStore();
    const { res } = await call(store, { action: 'list' }, { user: USER });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_admin' });
  });

  it('TC-B1-01：管理员成功 → 回 12 位码；库里只有哈希（找不到明文码），7 天、1 次、created_by、note 都对', async () => {
    const store = new FakeStore();
    const { res } = await call(store, { action: 'create', note: ' 10-29 #1 ' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const j = (await res.json()) as { code: string; expires_at: string };
    expect(Object.keys(j).sort()).toEqual(['code', 'expires_at']);
    expect(isInviteCode(j.code)).toBe(true);
    expect(Date.parse(j.expires_at)).toBe(NOW + INVITE_TTL_S * 1000);
    expect(INVITE_TTL_S).toBe(7 * 86400);

    expect(store.invites.size).toBe(1);
    const row = [...store.invites.values()][0];
    expect(row).toEqual({
      code_hash: await inviteCodeHash(j.code),
      created_by: ADMIN,
      max_uses: INVITE_MAX_USES,
      used_count: 0,
      expires_at: j.expires_at,
      note: '10-29 #1',
    });
    expect(INVITE_MAX_USES).toBe(1);
    expect(row?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    // 只存哈希：整行（含所有列）里都没有明文码
    expect(JSON.stringify(row)).not.toContain(j.code);
    // 计了一次
    expect(store.counters.get(keys.create(ADMIN, NOW))).toBe(1);
  });

  it('不写备注 → note 为 null', async () => {
    const store = new FakeStore();
    const { res } = await call(store, { action: 'create' });
    expect(res.status).toBe(200);
    expect([...store.invites.values()][0]?.note).toBeNull();
  });

  it('TC-B1-70：备注超过 40 个字符回 400 note_too_long，不计次数、不写库；正好 40 个可以', async () => {
    const store = new FakeStore();
    const { res } = await call(store, { action: 'create', note: '一'.repeat(41) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'note_too_long' });
    expect(store.invites.size).toBe(0);
    expect(store.counters.size).toBe(0);

    const ok = await call(store, { action: 'create', note: '一'.repeat(40) });
    expect(ok.res.status).toBe(200);
    expect([...store.invites.values()][0]?.note).toBe('一'.repeat(40));
  });

  it('备注不是字符串回 bad_request，不计次数', async () => {
    const store = new FakeStore();
    const { res } = await call(store, { action: 'create', note: 123 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request' });
    expect(store.counters.size).toBe(0);
  });

  it('安全审查必改 2：备注含 U+0000、孤立代理项、C0、双向覆盖字符回 400 bad_request，在 take_rate 之前（不计次数、不写库）', async () => {
    const store = new FakeStore();
    // 原样写进 JSON 正文：\\u0000、\\ud800 经 JSON.parse 变成真正的 U+0000 和孤立代理项
    for (const raw of ['a\\u0000b', 'a\\ud800b', 'a\\udc00', 'a\\u0007b', 'a\\nb', 'a\\u202eb', 'a\\u2066b']) {
      const { res } = await call(store, `{"action":"create","note":"${raw}"}`);
      expect(res.status, raw).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
    expect(store.counters.size).toBe(0);
    expect(store.invites.size).toBe(0);
    expect(store.calls.filter((c) => c === 'takeRate' || c === 'insertInvite')).toEqual([]);
  });

  it('TC-B1-01：每天 20 次，第 21 次回 429 rate_limited、不写库；第二天（UTC）重新计', async () => {
    const store = new FakeStore();
    expect(INVITE_DAILY_LIMIT).toBe(20);
    const codes = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const { res } = await call(store, { action: 'create', note: `#${i + 1}` });
      expect(res.status, `第 ${i + 1} 次`).toBe(200);
      codes.add(((await res.json()) as { code: string }).code);
    }
    expect(codes.size).toBe(20);
    expect(store.invites.size).toBe(20);

    const { res } = await call(store, { action: 'create', note: '#21' });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: 'rate_limited' });
    expect(store.invites.size).toBe(20);

    const next = await call(store, { action: 'create' }, { now: () => NOW + 86400 * 1000 });
    expect(next.res.status).toBe(200);
  });

  it('并发 30 个 create（假库的 take_rate 先计数再判断、每步都让出）：只成功 20 个，其余 429，库里 20 行', async () => {
    const store = new FakeStore();
    store.yieldEachCall = true;
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => call(store, { action: 'create', note: `#${i}` })));
    const statuses = results.map((r) => r.res.status);
    expect(statuses.filter((x) => x === 200)).toHaveLength(20);
    expect(statuses.filter((x) => x === 429)).toHaveLength(10);
    expect(store.invites.size).toBe(20);
    expect(store.counters.get(keys.create(ADMIN, NOW))).toBe(30);
  });

  it('TC-B1-01：停用的管理员（account_disabled）被拒，不查管理员表、不计次数、不写库', async () => {
    const store = new FakeStore();
    const { res } = await call(store, { action: 'create' }, { profile: { disabled: true } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'account_disabled' });
    expect(store.calls).toEqual([]);
    expect(store.invites.size).toBe(0);
    expect(store.counters.size).toBe(0);
  });

  it('TC-B1-10：没有 profiles 行的账号调 create、list 回 403 account_disabled，不查管理员表、不计次数', async () => {
    const store = new FakeStore();
    for (const action of ['create', 'list']) {
      const { res } = await call(store, { action }, { profile: { missing: true } });
      expect(res.status, action).toBe(403);
      expect(await res.json(), action).toEqual({ error: 'account_disabled' });
    }
    expect(store.calls).toEqual([]);
    expect(store.invites.size).toBe(0);
    expect(store.counters.size).toBe(0);
  });

  it('没带 JWT 401 unauthorized；会话被吊销 401 session_revoked；都不碰库', async () => {
    const store = new FakeStore();
    const d = deps(store);
    const noJwt = await handle(new Request('https://x/functions/v1/invite-admin', { method: 'POST', body: '{"action":"create"}' }), d);
    expect(noJwt.status).toBe(401);
    expect(await noJwt.json()).toEqual({ error: 'unauthorized' });
    const { res } = await call(store, { action: 'create' }, { profile: { revoked: true } });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'session_revoked' });
    expect(store.calls).toEqual([]);
  });

  it('生成的码撞了已有的哈希就换一个重来；连撞 3 次回 try_later', async () => {
    const store = new FakeStore();
    const A = 'ABCD2345EFGH';
    const B = 'WXYZ6789KLMN';
    expect((await call(store, { action: 'create' }, { codes: [A] })).res.status).toBe(200);
    const again = await call(store, { action: 'create' }, { codes: [A, B] });
    expect(again.res.status).toBe(200);
    expect(((await again.res.json()) as { code: string }).code).toBe(B);
    const fail = await call(store, { action: 'create' }, { codes: [A, A, A] });
    expect(fail.res.status).toBe(503);
    expect(await fail.res.json()).toEqual({ error: 'try_later' });
    expect(fail.logs).toEqual(['code_collision']);
  });

  it('数据库出错回 503 try_later，日志只记错误码', async () => {
    const store = new FakeStore();
    store.insertInvite = async () => { throw new Error('connection to db.xxx failed: password=…'); };
    const { res, logs } = await call(store, { action: 'create', note: '10-29' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'try_later' });
    expect(logs).toEqual(['db_error']);
  });
});

describe('invite-admin list', () => {
  it('只回本人发的、没过期的；只有备注、已用、上限、过期时刻四项（没有码、没有哈希）；不计次数', async () => {
    const store = new FakeStore();
    store.admins.add(USER);
    await call(store, { action: 'create', note: 'a' });
    await call(store, { action: 'create', note: 'b' }, { user: USER });
    store.invites.set('old', { code_hash: 'old', created_by: ADMIN, max_uses: 1, used_count: 1, expires_at: new Date(NOW - 1000).toISOString(), note: 'old' });
    const before = new Map(store.counters);
    const { res } = await call(store, { action: 'list' });
    expect(res.status).toBe(200);
    const j = (await res.json()) as { invites: Record<string, unknown>[] };
    expect(j.invites).toEqual([{ note: 'a', max_uses: 1, used_count: 0, expires_at: new Date(NOW + INVITE_TTL_S * 1000).toISOString() }]);
    expect(store.counters).toEqual(before);
  });
});

describe('请求形状、版本门', () => {
  it('非 POST 回 405，不鉴权', async () => {
    const store = new FakeStore();
    for (const m of ['GET', 'PUT', 'DELETE']) {
      const r = await handle(req(null, {}, m), deps(store));
      expect(r.status, m).toBe(405);
    }
    expect(store.calls).toEqual([]);
  });

  it('坏请求体、不认识的 action 回 bad_request', async () => {
    const store = new FakeStore();
    for (const b of ['not json', '[]', JSON.stringify({ action: 'delete' }), JSON.stringify({}), 'x'.repeat(5000)]) {
      const { res } = await call(store, b);
      expect(res.status, b.slice(0, 20)).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad_request' });
    }
    expect(store.invites.size).toBe(0);
  });

  it('不在免查名单：低于 min_client_version 回 426 upgrade_required，不计次数、不写库；非管理员先回 not_admin、不读配置', async () => {
    const store = new FakeStore();
    store.minVersion = '4.1.0';
    const { res } = await call(store, { action: 'create' }, {}, { 'x-app-version': '4.0.0' });
    expect(res.status).toBe(426);
    expect(((await res.json()) as { code: string }).code).toBe('upgrade_required');
    expect(store.invites.size).toBe(0);
    expect(store.counters.size).toBe(0);

    const ok = await call(store, { action: 'create' }, {}, { 'x-app-version': '4.1.0' });
    expect(ok.res.status).toBe(200);

    store.calls = [];
    const notAdmin = await call(store, { action: 'create' }, { user: USER }, { 'x-app-version': '4.0.0' });
    expect(notAdmin.res.status).toBe(403);
    expect(store.calls).toEqual(['isAdmin']);
  });
});

describe('错误码（shared/schema/invite-admin.ts，前后端共用）', () => {
  it('core.ts 的码和 shared/schema/invite-admin.ts 一字不差、顺序一致', () => {
    expect([...INVITE_ADMIN_ERRS]).toEqual([...INVITE_ADMIN_ERROR_CODES]);
    for (const c of INVITE_ADMIN_ERRS) expect(inviteAdminErrorCode.safeParse(c).success, c).toBe(true);
  });
});
