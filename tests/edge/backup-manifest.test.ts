// backup-manifest（架构第 6 节 backup-manifest 行、第 10 节“拉回本机”第 1 步；ADR-016 第 2 条；TC-B7a-24）。
// 证明：只收 POST；不带 Authorization、不是 Bearer、错值、拿别的服务器密钥（OPS_SECRET、CRON_SECRET 的值）来调都回 401，且不限流计数、不列桶、不签名；
// 目录（{}）回服务器算的首尔今天、最近 7 个日期、deleted_accounts、limits；一页（{date, after}）按人分页、每个文件一条 5 分钟签名链接，complete 看 _manifest；
// 只认 YYYY-MM-DD 日期目录、uuid 用户目录、备份文件名（<代>_<表>，B7a 评审第 5 条），正在做的标记 _running 不给链接；
// 1000 个账号也翻得完、每页文件有上限（B7a 复审第 5 条）；等待的页不签名、单独计数（复审第 6 条）；done 写心跳 backup-pull，detail 是服务器自己数的个数（复审第 8 条）；
// 日志只有错误码，没有请求头、链接、user_id；/sb 转发层对 backup-manifest 的 POST 不查版本（不带 X-App-Version 也不回 426）。
import { describe, expect, it } from 'vitest';
import { needsVersionCheck } from '../../functions/sb/version-gate.ts';
import { runningFile } from '../../supabase/functions/_shared/backup-format.ts';
import {
  HEARTBEAT, MANIFEST_FILE, PAGE_FILES, PAGE_USERS, PULL_HOURLY, RECENT_DAYS, SIGNED_URL_TTL_S, WAIT_HOURLY, handle,
  type Deps, type HeartbeatDetail, type Listed, type ManifestStore,
} from '../../supabase/functions/backup-manifest/core.ts';
import { COUNTER_KEY } from '../functions/account-fakes.ts';

const TOKEN = 'p'.repeat(48);
const OPS = 'o'.repeat(48);
const CRON = 'c'.repeat(48);
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const NOW = Date.UTC(2026, 11, 2, 0, 5);   // 首尔 2026-12-02 09:05
const uid = (i: number) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;

const folder = (name: string): Listed => ({ name, folder: true, bytes: null, updatedAt: null });
const file = (name: string, bytes = 10, updatedAt = '2026-12-01T15:31:00Z'): Listed => ({ name, folder: false, bytes, updatedAt });

type Out = Record<string, unknown> & {
  users: { user_id: string; complete: boolean; manifest_at: string | null; files?: { name: string; bytes: number; url: string }[] }[];
  next: string | null;
};

function setup(tree: Record<string, Listed[]>, o: { deleted?: { user_id: string; deleted_at: string | null }[]; allow?: boolean } = {}) {
  const calls = {
    list: [] as string[], sign: [] as { paths: string[]; ttl: number }[], rate: [] as { key: string; limit: number; win: number }[], deleted: 0,
    beats: [] as HeartbeatDetail[],
  };
  const codes: string[] = [];
  const store: ManifestStore = {
    async list(dir) { calls.list.push(dir); return tree[dir] ?? []; },
    async sign(paths, ttl) { calls.sign.push({ paths, ttl }); return paths.map((p) => `https://signed.example/${p}?token=t`); },
    async deletedAccounts() { calls.deleted++; return o.deleted ?? []; },
    // 真库 counters_key_check 不认的键写不进去（23514，rpcTakeRate 抛 db）：复审后本机链路实测 backup-manifest:pull:<小时> 就是这样 503 的
    async takeRate(key, limit, win) { if (!COUNTER_KEY.test(key)) throw new Error('db'); calls.rate.push({ key, limit, win }); return o.allow ?? true; },
    async writeHeartbeat(d) { calls.beats.push(d); },
  };
  const deps: Deps = { pullToken: TOKEN, store, now: () => NOW, log: (c) => codes.push(c) };
  const call = (auth: string | null, body: unknown = {}, method = 'POST') => {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (auth !== null) headers.set('authorization', auth);
    return handle(new Request('https://x/backup-manifest', method === 'GET' ? { method, headers } : { method, headers, body: JSON.stringify(body) }), deps);
  };
  const ok = async (body: unknown) => {
    const r = await call(`Bearer ${TOKEN}`, body);
    expect(r.status).toBe(200);
    return await r.json() as Out;
  };
  const touched = () => calls.list.length + calls.sign.length + calls.rate.length + calls.deleted + calls.beats.length;
  return { calls, codes, deps, call, ok, touched };
}

describe('backup-manifest：鉴权（TC-B7a-24）', () => {
  it('TC-B7a-24 不带、不是 Bearer、错值、别的服务器密钥的值、大小写不对都回 401，不计次数、不列桶、不签名', async () => {
    const s = setup({});
    const bad = [null, '', TOKEN, `Basic ${TOKEN}`, `Bearer ${'p'.repeat(47)}`, `Bearer ${TOKEN}x`, `bearer ${TOKEN}`, `Bearer  ${TOKEN}`,
      `Bearer ${OPS}`, `Bearer ${CRON}`, `Bearer ${TOKEN.toUpperCase()}`];
    for (const auth of bad) {
      const r = await s.call(auth);
      expect([r.status, await r.json()], String(auth)).toEqual([401, { error: 'unauthorized' }]);
    }
    expect(s.touched()).toBe(0);
    expect(s.codes).toEqual([]);
  });

  it('TC-B7a-24 只收 POST；没配 BACKUP_PULL_TOKEN 也回 401（看不出配没配）；密钥太短算没配好 500；store 没配好 500', async () => {
    const s = setup({});
    expect((await s.call(`Bearer ${TOKEN}`, {}, 'GET')).status).toBe(405);
    const noTok = await handle(new Request('https://x', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }), { ...s.deps, pullToken: undefined });
    expect(noTok.status).toBe(401);
    const short = await handle(new Request('https://x', { method: 'POST', headers: { authorization: 'Bearer short' } }), { ...s.deps, pullToken: 'short' });
    expect(short.status).toBe(500);
    const noStore = await handle(new Request('https://x', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }), { ...s.deps, store: null });
    expect([noStore.status, await noStore.json()]).toEqual([500, { error: 'misconfigured' }]);
    expect(s.touched()).toBe(0);
  });

  it('请求体不对 400、不计次数：空、不是对象、多字段、日期或 after 写法不对、wait 不是布尔、done 带别的', async () => {
    const s = setup({});
    for (const body of [null, [], 'x', { date: '2026-12-02', x: 1 }, { date: '2026-1-2' }, { date: '2026-12-02', after: 'u1' }, { date: '2026-12-02', wait: 'yes' },
      { done: true, date: '2026-12-02' }, { done: 1 }, { after: A }]) {
      const r = await s.call(`Bearer ${TOKEN}`, body);
      expect([r.status, await r.json()], JSON.stringify(body)).toEqual([400, { error: 'bad_request' }]);
    }
    const empty = await handle(new Request('https://x', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } }), s.deps);
    expect(empty.status).toBe(400);
    expect(s.touched()).toBe(0);
  });

  it('TC-B7a-24 /sb 转发层对 backup-manifest 的 POST 不查版本（pull.ps1 不带 X-App-Version 不回 426）；别的方法照查', () => {
    expect(needsVersionCheck('POST', '/functions/v1/backup-manifest')).toBe(false);
    expect(needsVersionCheck('GET', '/functions/v1/backup-manifest')).toBe(true);
    // backup-daily 是服务器直连（cron、自己调自己），不走 /sb：转发层照查
    expect(needsVersionCheck('POST', '/functions/v1/backup-daily')).toBe(true);
  });
});

describe('backup-manifest：目录和一页', () => {
  const tree: Record<string, Listed[]> = {
    '': [folder('2026-11-24'), folder('2026-11-25'), folder('2026-11-26'), folder('2026-11-27'), folder('2026-11-28'), folder('2026-11-29'),
      folder('2026-11-30'), folder('2026-12-01'), folder('2026-12-02'), folder('tmp'), folder('2026-1-3'), file('stray.json.gz')],
    '2026-12-02': [folder(A), folder(B), folder('not-a-user'), file('loose.json.gz')],
    [`2026-12-02/${A}`]: [file('a_profiles.json.gz', 120), file('a_notes.1.json.gz', 900), file('a_notes.2.json.gz', 300), file(MANIFEST_FILE, 80, '2026-12-01T15:32:00Z'),
      file('evil.sh'), file('../x.json.gz'), file('notes.json.gz'), file('c_notes.json.gz'), file(runningFile(1, 0)), file(runningFile(2, 3)), folder('sub')],
    [`2026-12-02/${B}`]: [file('b_profiles.json.gz', 110)],   // 没有 _manifest：没做完
    '2026-11-24': [folder(A)],
    [`2026-11-24/${A}`]: [file(MANIFEST_FILE)],
  };

  it('TC-B7a-24 目录：服务器算的首尔今天、最近 7 天（只认 YYYY-MM-DD）、deleted_accounts（只认 uuid）、limits；只列根目录，不签名', async () => {
    const s = setup(tree, { deleted: [{ user_id: B, deleted_at: '2026-11-30T00:00:00Z' }, { user_id: 'junk', deleted_at: null }] });
    const r = await s.call(`Bearer ${TOKEN}`, {});
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual({
      ok: true, generated_at: new Date(NOW).toISOString(), today: '2026-12-02',
      dates: ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30', '2026-12-01', '2026-12-02'],
      deleted_accounts: [{ user_id: B, deleted_at: '2026-11-30T00:00:00Z' }],
      limits: { page_users: PAGE_USERS, pull_hourly: PULL_HOURLY, wait_hourly: WAIT_HOURLY },
    });
    expect(RECENT_DAYS).toBe(7);
    expect([s.calls.list, s.calls.sign.length]).toEqual([[''], 0]);
    expect(s.calls.rate).toEqual([{ key: 'backup-manifest-pull:global:2026120200', limit: PULL_HOURLY, win: 3600 }]);
    // 首尔 00:00 前后：UTC 14:59 还是前一天，15:00 就是第二天
    s.deps.now = () => Date.UTC(2026, 11, 2, 14, 59);
    expect((await s.ok({})).today).toBe('2026-12-02');
    s.deps.now = () => Date.UTC(2026, 11, 2, 15, 0);
    expect((await s.ok({})).today).toBe('2026-12-03');
  });

  it('TC-B7a-24 一页：每人的文件和 5 分钟签名链接、complete 看 _manifest；不认的文件名、_running 不给链接；不在最近 7 天的日期回空', async () => {
    const s = setup(tree);
    const out = await s.ok({ date: '2026-12-02' });
    expect([out['date'], out['expires_in'], out.next]).toEqual(['2026-12-02', SIGNED_URL_TTL_S, null]);
    expect(out.users.map((u) => [u.user_id, u.complete, u.manifest_at])).toEqual([[A, true, '2026-12-01T15:32:00Z'], [B, false, null]]);
    expect(out.users[0]?.files?.map((f) => [f.name, f.bytes])).toEqual([['a_profiles.json.gz', 120], ['a_notes.1.json.gz', 900], ['a_notes.2.json.gz', 300], [MANIFEST_FILE, 80]]);
    expect(out.users[0]?.files?.[0]?.url).toBe(`https://signed.example/2026-12-02/${A}/a_profiles.json.gz?token=t`);
    expect(s.calls.sign).toEqual([{ ttl: 300, paths: [
      `2026-12-02/${A}/a_profiles.json.gz`, `2026-12-02/${A}/a_notes.1.json.gz`, `2026-12-02/${A}/a_notes.2.json.gz`, `2026-12-02/${A}/${MANIFEST_FILE}`,
      `2026-12-02/${B}/b_profiles.json.gz`,
    ] }]);
    // 2026-11-24 已经不在最近 7 天：不列它（服务器过期还没删到的也不给）
    const old = await s.ok({ date: '2026-11-24' });
    expect([old.users, old.next]).toEqual([[], null]);
    expect(s.calls.list).not.toContain('2026-11-24');
    expect(s.calls.list).not.toContain('tmp');
  });

  it('B7a 复审第 5 条：1000 个账号按 after 翻 20 页拿全、不重不漏；每页最多 50 人、文件到上限就停', async () => {
    const big: Record<string, Listed[]> = { '': [folder('2026-12-02')], '2026-12-02': [] };
    const ids = Array.from({ length: 1000 }, (_, i) => uid(i + 1));
    for (const u of ids) {
      big['2026-12-02']?.push(folder(u));
      big[`2026-12-02/${u}`] = [...Array.from({ length: 22 }, (_, i) => file(`a_t${String.fromCharCode(97 + i)}.json.gz`)), file(MANIFEST_FILE)];
    }
    const s = setup(big);
    const got: string[] = [];
    let after: string | null = null;
    let n = 0;
    let maxFiles = 0;
    do {
      const out: Out = await s.ok(after === null ? { date: '2026-12-02' } : { date: '2026-12-02', after });
      n++;
      expect(out.users.length).toBeLessThanOrEqual(PAGE_USERS);
      maxFiles = Math.max(maxFiles, out.users.reduce((x, u) => x + (u.files?.length ?? 0), 0));
      got.push(...out.users.map((u) => u.user_id));
      after = out.next;
    } while (after !== null);
    expect([n, got]).toEqual([20, ids]);
    expect(maxFiles).toBe(50 * 23);
    expect(s.codes).toEqual([]);
    // 每人文件多：到 PAGE_FILES 就停（一页最多 PAGE_FILES + 一个人的文件）
    for (const u of ids.slice(0, 10)) big[`2026-12-02/${u}`] = Array.from({ length: 400 }, (_, i) => file(`a_t.${i + 1}.json.gz`));
    const fat = await s.ok({ date: '2026-12-02' });
    expect([fat.users.length, fat.next]).toEqual([Math.ceil(PAGE_FILES / 400), ids[3]]);
  });

  it('B7a 复审第 6 条：等待的页只回 complete、manifest_at，不签名，单独计数 backup-manifest-wait:global:<UTC 小时>', async () => {
    const s = setup(tree);
    const out = await s.ok({ date: '2026-12-02', wait: true });
    expect(out.users).toEqual([{ user_id: A, complete: true, manifest_at: '2026-12-01T15:32:00Z' }, { user_id: B, complete: false, manifest_at: null }]);
    expect(s.calls.sign).toEqual([]);
    expect(s.calls.rate).toEqual([{ key: 'backup-manifest-wait:global:2026120200', limit: WAIT_HOURLY, win: 3600 }]);
  });

  it('次数用完 429、不列桶：拉取和等待各是各的键', async () => {
    const s = setup(tree, { allow: false });
    for (const body of [{}, { date: '2026-12-02' }, { date: '2026-12-02', wait: true }, { done: true }]) {
      const r = await s.call(`Bearer ${TOKEN}`, body);
      expect([r.status, await r.json()]).toEqual([429, { error: 'rate_limited' }]);
    }
    expect(s.calls.rate.map((x) => x.key)).toEqual(['backup-manifest-pull:global:2026120200', 'backup-manifest-pull:global:2026120200', 'backup-manifest-wait:global:2026120200', 'backup-manifest-pull:global:2026120200']);
    expect([s.calls.list.length, s.calls.beats.length]).toEqual([0, 0]);
  });

  it('桶或库出错 503 store_error；签名条数对不上也算出错；日志里没有请求头、链接、user_id', async () => {
    const s = setup(tree);
    s.deps.store = { ...(s.deps.store as ManifestStore), sign: async () => ['only-one'] };
    const r = await s.call(`Bearer ${TOKEN}`, { date: '2026-12-02' });
    expect([r.status, await r.json()]).toEqual([503, { error: 'try_later' }]);
    expect(s.codes).toEqual(['store_error']);
    const joined = s.codes.join(' ');
    for (const leak of [TOKEN, A, B, 'signed.example', 'Bearer']) expect(joined).not.toContain(leak);
  });

  it('一个人目录里东西异常多：too_many_objects、503，不签名', async () => {
    const many: Record<string, Listed[]> = { '': [folder('2026-12-02')], '2026-12-02': [folder(A)], [`2026-12-02/${A}`]: Array.from({ length: 2001 }, (_, i) => file(`a_t.${(i % 9999) + 1}.json.gz`)) };
    const s = setup(many);
    expect((await s.call(`Bearer ${TOKEN}`, { date: '2026-12-02' })).status).toBe(503);
    expect(s.codes).toEqual(['too_many_objects']);
    expect(s.calls.sign.length).toBe(0);
  });

  it('桶是空的：目录 dates 为空，一页 users 为空、不调签名', async () => {
    const s = setup({});
    expect((await s.ok({})).dates).toEqual([]);
    expect((await s.ok({ date: '2026-12-02' })).users).toEqual([]);
    expect(s.calls.sign.length).toBe(0);
  });
});

describe('backup-manifest：done 写心跳（B7a 复审第 8 条）', () => {
  it('写 backup-pull 心跳，detail 是服务器自己数的：最多一天几个账号、拉一遍几次、等待每轮几页和两个上限', async () => {
    expect(HEARTBEAT).toBe('backup-pull');
    const tree: Record<string, Listed[]> = { '': [folder('2026-12-01'), folder('2026-12-02')], '2026-12-01': [folder(A)], '2026-12-02': [] };
    for (let i = 1; i <= 120; i++) tree['2026-12-02']?.push(folder(uid(i)));
    const s = setup(tree);
    expect(await s.ok({ done: true })).toEqual({ ok: true });
    // 目录 1 + 12-01 一页 + 12-02 三页 + done 1
    expect(s.calls.beats).toEqual([{ accounts: 120, pull_calls: 6, pull_limit: PULL_HOURLY, wait_pages: 3, wait_limit: WAIT_HOURLY }]);
    expect(s.calls.sign.length).toBe(0);
    const bad = setup(tree);
    bad.deps.store = { ...(bad.deps.store as ManifestStore), writeHeartbeat: async () => { throw new Error('db'); } };
    expect((await bad.call(`Bearer ${TOKEN}`, { done: true })).status).toBe(503);
  });

  it('按 1000 个账号算：拉一遍 142 次（≤ PULL_HOURLY 的一半），等待每轮 20 页', async () => {
    const tree: Record<string, Listed[]> = { '': [] };
    for (let d = 26; d <= 32; d++) {
      const date = d <= 30 ? `2026-11-${d}` : `2026-12-0${d - 30}`;
      tree['']?.push(folder(date));
      tree[date] = Array.from({ length: 1000 }, (_, i) => folder(uid(i + 1)));
    }
    const s = setup(tree);
    await s.ok({ done: true });
    expect(s.calls.beats[0]).toEqual({ accounts: 1000, pull_calls: 142, pull_limit: 300, wait_pages: 20, wait_limit: 600 });
    expect(142 * 2).toBeLessThanOrEqual(PULL_HOURLY);
  });
});
