// backup-daily（架构第 10 节“服务器端”、第 6 节 backup-daily 行；ADR-016 第 1 条；0.29 续第 33、84 条；0.47 第 18 条；
// TC-B7a-23、TC-B1-109、TC-DEL-bucket-backups；B7a 评审第 5、6 条）。
// 证明：鉴权和没配好；停用、冷静期账号跳过；两个用户各写各的目录（<日期>/<user_id>/<代>_<表>.json.gz）、contentType application/gzip、
// 路径过得了清单 backups 桶的 pathPattern；一张表一段写不完按序号切片、每片原文不超预算、拼回来行数和顺序都对；最后写 _manifest（行数、sha256、gen）；
// 同一天再跑写另一代、写完 _manifest 才删旧一代，中途失败旧的那份原样留着；正在做的标记没过期时 start、retry、publish 都跳过，
// 被新一轮接管的接力停下；补跑看到 _manifest 就跳过；start 和 publish 各有各的次数上限；接力的进度逐项校验；
// 别人的行、文件太大都失败且不写 _manifest；发下一段失败重试一次；日志只记错误码。真清单里 backup: 'json' 的表全有主键说明（TABLE_KEYS）。
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { allManifests } from '../../shared/manifests/index.ts';
import {
  BACKUP_LIMITS, GZIP, MANIFEST_FILE, RUNNING_RE, TABLE_KEYS, backupDate, backupTablesOf, handle, runningFile,
  type BackupFiles, type BackupLimits, type BackupStore, type BackupTable, type ContinueBody, type Deps, type HeartbeatDetail,
} from '../../supabase/functions/backup-daily/core.ts';

const SECRET = 's'.repeat(40);
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const RUN = '00000000-0000-4000-8000-0000000000ff';
const OTHER_RUN = '00000000-0000-4000-8000-0000000000ee';
// 15:30 UTC = 首尔第二天 00:30（cron 的时刻），备份日期是首尔的那一天
const NOW = Date.UTC(2026, 11, 1, 15, 30);
const DATE = '2026-12-02';
const BUCKET_PATTERN = new RegExp(
  allManifests.flatMap((m) => m.buckets ?? []).find((b) => b.name === 'backups')?.pathPattern ?? 'missing',
);

const t = (name: string, o: Partial<BackupTable> = {}): BackupTable => ({
  name, schema: 'public', lookupCol: 'user_id', keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: 25_000, ...o,
});
const TABLES: BackupTable[] = [
  t('profiles', { keyCol: 'user_id', keyType: 'self', conflict: ['user_id'], maxRows: 1 }),
  t('notes'),
  t('vault_credentials', { schema: 'private', keyCol: 'credential_id', keyType: 'text', conflict: ['credential_id'], maxRows: 1000, rpc: true }),
];

let seq = 0;
const id = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`;
const note = (user: string, body = 'x') => ({ id: id(), user_id: user, rev: 1, body });
const gz = (o: unknown) => new Uint8Array(gzipSync(Buffer.from(JSON.stringify(o))));
const dir = (u: string) => `${DATE}/${u}`;
/** 认领标记：第 e 轮第 k 段（_running.<e×1000+k>.json.gz） */
const mark = (u: string, e = 1, k = 0) => `${dir(u)}/${runningFile(e, k)}`;
const isMark = (p: string) => RUNNING_RE.test(p.split('/').pop() ?? '');

type Row = Record<string, unknown>;
interface Stored { body: Uint8Array; contentType: string; updatedAt: string }
function world(rows: Record<string, Row[]>, clock: () => number) {
  const files = new Map<string, Stored>();
  const uploads: string[] = [];
  const creates: string[] = [];
  const removed: string[][] = [];
  const reads: { table: string; user: string; after: unknown; limit: number }[] = [];
  const beats: HeartbeatDetail[] = [];
  const rates: { key: string; limit: number }[] = [];
  let allow = true;
  const store: BackupStore = {
    async readPage(tbl, userId, after, limit) {
      reads.push({ table: tbl.name, user: userId, after, limit });
      const all = (rows[tbl.name] ?? []).filter((r) => r[tbl.lookupCol] === userId);
      const key = (r: Row) => String(r[tbl.keyCol]);
      return all.filter((r) => after === null || key(r) > String(after)).sort((x, y) => (key(x) < key(y) ? -1 : 1)).slice(0, limit);
    },
    async writeHeartbeat(d) { beats.push(d); },
    async takeRate(key, limit) { rates.push({ key, limit }); return allow; },
  };
  const bucket: BackupFiles = {
    async list(d) {
      return [...files.entries()]
        .filter(([p]) => p.startsWith(`${d}/`) && !p.slice(d.length + 1).includes('/'))
        .map(([p, f]) => ({ name: p.slice(d.length + 1), updatedAt: f.updatedAt }));
    },
    async read(p) { return files.get(p)?.body ?? null; },
    async remove(paths) { removed.push(paths); for (const p of paths) files.delete(p); },
    async upload(p, body, opts) { uploads.push(p); files.set(p, { body, contentType: opts.contentType, updatedAt: new Date(clock()).toISOString() }); },
    // 和 Storage upsert=false 一样：同名已经有了就建不成（creates 记每一次尝试，uploads 只记建成的）
    async create(p, body, opts) {
      creates.push(p);
      if (files.has(p)) return false;
      uploads.push(p);
      files.set(p, { body, contentType: opts.contentType, updatedAt: new Date(clock()).toISOString() });
      return true;
    },
  };
  /** 直接放一个文件进桶（模拟上一轮留下的） */
  const put = (p: string, body: Uint8Array = new Uint8Array(), at = clock()) => files.set(p, { body, contentType: GZIP, updatedAt: new Date(at).toISOString() });
  return { files, uploads, creates, removed, reads, beats, rates, store, bucket, put, deny: () => { allow = false; } };
}

function setup(rows: Record<string, Row[]>, o: { limits?: Partial<BackupLimits>; usable?: (u: string) => Promise<boolean>; next?: (b: ContinueBody) => Promise<number>; tables?: BackupTable[] } = {}) {
  let now = NOW;
  const w = world(rows, () => now);
  const codes: string[] = [];
  const pending: Promise<unknown>[] = [];
  const chained: ContinueBody[] = [];
  const deps: Deps = {
    cronSecret: SECRET, store: w.store, files: w.bucket, tables: o.tables ?? TABLES,
    isUsable: o.usable ?? (async () => true),
    // 默认：像真的一样把下一段当一次新调用跑（各段的 deps 相同）
    next: o.next ?? (async (b) => { chained.push(b); return (await call(b)).status; }),
    background: (p) => { pending.push(p); },
    now: () => now, newId: () => RUN, log: (c) => codes.push(c), project: 'testref',
    ...(o.limits ? { limits: o.limits } : {}),
  };
  const call = (body: unknown, secret: string | null = SECRET, method = 'POST') =>
    handle(new Request('https://x/backup-daily', {
      method, headers: secret === null ? {} : { 'x-cron-secret': secret },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    }), deps);
  /** 跑完整条接力（后台发的下一段一个接一个 await 完） */
  const drain = async () => { while (pending.length) await pending.shift(); };
  return { ...w, codes, chained, deps, call, drain, setNow: (ms: number) => { now = ms; } };
}

const gun = (b: Uint8Array) => JSON.parse(gunzipSync(b).toString('utf8')) as Record<string, unknown>;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
type Man = { user_id: string; date: string; run_id: string; gen: string; project: string | null; tables: { name: string; schema: string; key: string[]; lookup: string; rows: number; files: { name: string; bytes: number; sha256: string }[] }[] };
const manOf = (s: { files: Map<string, Stored> }, u: string) => gun(s.files.get(`${dir(u)}/${MANIFEST_FILE}`)?.body ?? new Uint8Array()) as unknown as Man;

describe('backup-daily：鉴权和没配好', () => {
  it('只收 POST；不带、错的 x-cron-secret 回 401 且不读库不碰桶；没配好 500', async () => {
    const s = setup({ notes: [note(A)] });
    expect((await s.call(null, SECRET, 'GET')).status).toBe(405);
    expect((await s.call({ user_id: A }, null)).status).toBe(401);
    expect((await s.call({ user_id: A }, 'x'.repeat(40))).status).toBe(401);
    expect([s.reads.length, s.uploads.length, s.rates.length]).toEqual([0, 0, 0]);
    const r = await handle(new Request('https://x', { method: 'POST', headers: { 'x-cron-secret': SECRET }, body: '{}' }), { ...s.deps, files: null });
    expect([r.status, await r.json()]).toEqual([500, { error: 'misconfigured' }]);
    // 没配密钥：调用方看不出配没配，照样 401；密钥太短算没配好 500
    const r2 = await handle(new Request('https://x', { method: 'POST', headers: { 'x-cron-secret': SECRET }, body: '{}' }), { ...s.deps, cronSecret: undefined });
    expect(r2.status).toBe(401);
    const r3 = await handle(new Request('https://x', { method: 'POST', headers: { 'x-cron-secret': 'short' }, body: '{}' }), { ...s.deps, cronSecret: 'short' });
    expect(r3.status).toBe(500);
  });

  it('请求体不对回 400：不是 JSON、多字段、user_id 不是 uuid、mode 不认识（含 continue）、mode 和 state 一起带', async () => {
    const s = setup({});
    for (const body of ['nope', { user_id: A, x: 1 }, { user_id: 'abc' }, { user_id: A, mode: 'all' }, { user_id: A, mode: 'continue' }, { user_id: A, mode: 'start', state: {} }, [A]]) {
      expect((await s.call(body)).status).toBe(400);
    }
    expect([s.reads.length, s.uploads.length]).toEqual([0, 0]);
  });
});

describe('backup-daily：停用账号（TC-B1-109）', () => {
  it('TC-B1-109 backup-daily：管理员停用（disabled_at 有值）的账号跳过', async () => {
    const s = setup({ notes: [note(A), note(B)] }, { usable: async (u) => u !== A });
    const r = await s.call({ user_id: A });
    expect(await r.json()).toEqual({ ok: true, skipped: 'not_usable' });
    expect([s.reads.length, s.uploads.length, s.rates.length, s.removed.length]).toEqual([0, 0, 0, 0]);
    expect((await (await s.call({ user_id: B })).json()).done).toBe(true);
    expect(s.uploads.every((p) => p.startsWith(`${dir(B)}/`))).toBe(true);
  });
  it('TC-B1-109 backup-daily：注销冷静期（disabled_reason = deletion）的账号跳过', async () => {
    // 做到一半进了冷静期：后面的段不再写，也不写 _manifest（这一天算没做完）
    let usable = true;
    const rows = { notes: Array.from({ length: 30 }, () => note(A, 'y'.repeat(200))) };
    const got: ContinueBody[] = [];
    const s = setup(rows, { usable: async () => usable, limits: { segmentRawBytes: 1500, firstPage: 5, page: 5 }, next: async (b) => { got.push(b); return 200; } });
    expect((await (await s.call({ user_id: A })).json()).done).toBe(false);
    await s.drain();
    usable = false;
    const r = await s.call(JSON.parse(JSON.stringify(got.at(-1))));
    expect(await r.json()).toEqual({ ok: true, skipped: 'not_usable' });
    expect(s.files.has(`${dir(A)}/${MANIFEST_FILE}`)).toBe(false);
  });
});

/** 自己接 next 时拿到第一段交出去的进度 */
async function nextBody(s: ReturnType<typeof setup>): Promise<ContinueBody> {
  const got: ContinueBody[] = [];
  s.deps.next = async (b) => { got.push(b); return 200; };
  await s.call({ user_id: A });
  await s.drain();
  const b = got.at(-1);
  if (!b) throw new Error('no chain');
  return b;
}

describe('backup-daily：两个用户各写各的（TC-B7a-23）', () => {
  it('TC-B7a-23 两个用户：文件只在 <日期>/<user_id>/ 下、contentType application/gzip、路径过 pathPattern、内容只有自己的行，_manifest 行数和 sha256 对得上', async () => {
    const rows = {
      profiles: [{ user_id: A, tz: 'Asia/Seoul' }, { user_id: B, tz: 'Asia/Seoul' }],
      notes: [note(A, 'a1'), note(B, 'b1'), note(A, 'a2'), note(B, 'b2'), note(B, 'b3')],
      vault_credentials: [{ credential_id: 'cred-A_1', user_id: A }, { credential_id: 'cred-B_1', user_id: B }],
    };
    const s = setup(rows);
    for (const u of [A, B]) {
      const r = await s.call({ user_id: u });
      expect(await r.json()).toEqual({ ok: true, date: DATE, done: true, files: ['a_profiles.json.gz', 'a_notes.json.gz', 'a_vault_credentials.json.gz', MANIFEST_FILE] });
    }
    // 做完以后正在做的标记删掉了；桶里只有 a 代数据文件和 _manifest
    expect([...s.files.keys()].sort()).toEqual([A, B].flatMap((u) => ['_manifest', 'a_notes', 'a_profiles', 'a_vault_credentials'].map((n) => `${dir(u)}/${n}.json.gz`)).sort());
    expect(s.uploads.filter(isMark)).toEqual([mark(A), mark(B)]);
    for (const p of s.uploads) expect(p).toMatch(BUCKET_PATTERN);
    for (const f of s.files.values()) expect(f.contentType).toBe(GZIP);
    for (const u of [A, B]) {
      const notes = gun(s.files.get(`${dir(u)}/a_notes.json.gz`)?.body ?? new Uint8Array());
      expect(notes).toMatchObject({ format: 'lemomemo-backup', version: 1, table: 'notes' });
      expect((notes.rows as Row[]).every((r) => r.user_id === u)).toBe(true);
      expect((notes.rows as Row[]).length).toBe(u === A ? 2 : 3);
      const man = manOf(s, u);
      expect([man.user_id, man.date, man.run_id, man.gen, man.project]).toEqual([u, DATE, RUN, 'a', 'testref']);
      expect(man.tables.map((x) => x.lookup)).toEqual(['user_id', 'user_id', 'user_id']);
      expect(man.tables.map((x) => [x.name, x.schema, x.key, x.rows])).toEqual([
        ['profiles', 'public', ['user_id'], 1], ['notes', 'public', ['id'], u === A ? 2 : 3], ['vault_credentials', 'private', ['credential_id'], 1],
      ]);
      for (const tb of man.tables) {
        for (const f of tb.files) {
          const body = s.files.get(`${dir(u)}/${f.name}`)?.body ?? new Uint8Array();
          expect([f.bytes, f.sha256]).toEqual([body.byteLength, sha(body)]);
        }
      }
    }
    expect(s.beats).toEqual([{ rows: 4, files: 3, segments: 1 }, { rows: 5, files: 3, segments: 1 }]);
    // 读库每次都带这个人：没有读别人的
    expect(s.reads.every((r) => r.user === A || r.user === B)).toBe(true);
  });

  it('TC-B7a-23 大表切片：一段原文到预算就切一片，序号从 1 起、每片原文不超“预算 + 一页”、拼回来行数和顺序都对，最后才写 _manifest', async () => {
    const big = Array.from({ length: 137 }, () => note(A, 'z'.repeat(300)));
    const lim = { segmentRawBytes: 8000, firstPage: 5, page: 10 };
    const s = setup({ profiles: [{ user_id: A }], notes: big, vault_credentials: [] }, { limits: lim });
    const first = await (await s.call({ user_id: A })).json();
    expect(first).toMatchObject({ ok: true, date: DATE, done: false });
    expect(s.files.has(`${dir(A)}/${MANIFEST_FILE}`)).toBe(false);
    expect(s.files.has(mark(A))).toBe(true);
    await s.drain();
    const names = [...s.files.keys()].map((p) => p.slice(`${dir(A)}/`.length));
    const slices = names.filter((n) => n.startsWith('a_notes.')).sort((x, y) => Number(x.split('.')[1]) - Number(y.split('.')[1]));
    expect(slices.length).toBeGreaterThan(3);
    expect(slices).toEqual(slices.map((_, i) => `a_notes.${i + 1}.json.gz`));
    expect(names).not.toContain('a_notes.json.gz');
    expect(names.filter(isMark)).toEqual([]);
    const pageMax = lim.page * (JSON.stringify(big[0]).length + 1);
    const joined: Row[] = [];
    for (const n of slices) {
      const f = gun(s.files.get(`${dir(A)}/${n}`)?.body ?? new Uint8Array());
      expect(JSON.stringify(f).length).toBeLessThanOrEqual(lim.segmentRawBytes + pageMax + 200);
      joined.push(...(f.rows as Row[]));
    }
    expect(joined.map((r) => r.id)).toEqual(big.map((r) => r.id).sort());
    const man = manOf(s, A);
    expect(man.tables.find((x) => x.name === 'notes')).toMatchObject({ rows: 137 });
    expect(man.tables.find((x) => x.name === 'notes')?.files.map((f) => f.name)).toEqual(slices);
    expect(man.tables.find((x) => x.name === 'vault_credentials')).toMatchObject({ rows: 0, files: [{ name: 'a_vault_credentials.json.gz' }] });
    expect(s.uploads.at(-1)).toBe(`${dir(A)}/${MANIFEST_FILE}`);
    expect(s.beats).toEqual([{ rows: 138, files: slices.length + 2, segments: s.chained.length + 1 }]);
    // 接力每段一次新调用；只有第一段算每天的发起次数
    expect(s.rates.length).toBe(1);
  });

  it('宽行按平均行宽缩小一页，至少 minPage 行', async () => {
    const wide = Array.from({ length: 40 }, () => note(A, 'w'.repeat(20_000)));
    const s = setup({ notes: wide }, { tables: [t('notes')], limits: { firstPage: 5, page: 250, wideRowBytes: 8 * 1024, pageRawBytes: 100_000, minPage: 3 } });
    await s.call({ user_id: A });
    await s.drain();
    expect(s.reads.map((r) => r.limit).slice(0, 3)).toEqual([5, 4, 4]);
  });
});

describe('backup-daily：同一天再跑写另一代（B7a 评审第 5 条）', () => {
  it('当天已有 a 代：先删 b 代残片，写 b 代，写完 _manifest（gen: b）才删 a 代和标记', async () => {
    const s = setup({ notes: [note(A)] }, { tables: [t('notes')] });
    s.put(`${dir(A)}/a_notes.json.gz`, gz({ old: true }));
    s.put(`${dir(A)}/b_notes.3.json.gz`);   // 上一轮没做完的 b 代残片
    s.put(`${dir(A)}/${MANIFEST_FILE}`, gz({ gen: 'a' }));
    const r = await (await s.call({ user_id: A })).json();
    expect(r).toEqual({ ok: true, date: DATE, done: true, files: ['b_notes.json.gz', MANIFEST_FILE] });
    expect(s.removed.map((x) => [...x].sort())).toEqual([[`${dir(A)}/b_notes.3.json.gz`], [mark(A), `${dir(A)}/a_notes.json.gz`].sort()]);
    expect([...s.files.keys()].sort()).toEqual([`${dir(A)}/${MANIFEST_FILE}`, `${dir(A)}/b_notes.json.gz`]);
    expect(manOf(s, A).gen).toBe('b');
    // 再跑一次又换回 a
    s.setNow(NOW + 60_000);
    expect((await (await s.call({ user_id: A })).json()).files).toEqual(['a_notes.json.gz', MANIFEST_FILE]);
    expect(manOf(s, A).gen).toBe('a');
  });

  it('列完目录到建成标记之间上一轮刚做完（写了 a 代 _manifest、删光标记）：按建成后重新列的结果定代，写 b 代，不删 a 代（复查第二轮第 1 条）', async () => {
    const s = setup({ notes: [note(A)] }, { tables: [t('notes')] });
    const create = s.bucket.create.bind(s.bucket);
    s.bucket.create = async (p, body, opts) => {
      if (p === mark(A)) {   // 这一刻上一轮做完：a 代文件和 _manifest 落地
        s.put(`${dir(A)}/a_notes.json.gz`, gz({ prev: true }));
        s.put(`${dir(A)}/${MANIFEST_FILE}`, gz({ gen: 'a' }));
      }
      return create(p, body, opts);
    };
    const r = await (await s.call({ user_id: A })).json();
    expect(r.files).toEqual(['b_notes.json.gz', MANIFEST_FILE]);
    expect(s.removed.flat().filter((p) => p.includes('/b_'))).toEqual([]);
    expect(manOf(s, A).gen).toBe('b');
  });

  it('_manifest 读不出 gen（坏文件）时写 a 代', async () => {
    const s = setup({ notes: [note(A)] }, { tables: [t('notes')] });
    s.put(`${dir(A)}/${MANIFEST_FILE}`, new Uint8Array([1, 2, 3]));
    expect((await (await s.call({ user_id: A })).json()).files).toEqual(['a_notes.json.gz', MANIFEST_FILE]);
  });

  it('第二轮中途失败：旧的 _manifest 和旧一代文件原样留着，当天那份备份不丢', async () => {
    const rows = { notes: [note(A, 'v1')] };
    const s = setup(rows, { tables: [t('notes')] });
    await s.call({ user_id: A });
    const before = new Map([...s.files].map(([p, f]) => [p, sha(f.body)]));
    s.setNow(NOW + 60_000);
    s.store.readPage = async () => { throw new Error('boom'); };
    expect((await s.call({ user_id: A })).status).toBe(503);
    for (const [p, h] of before) expect(sha(s.files.get(p)?.body ?? new Uint8Array())).toBe(h);
    expect(manOf(s, A).gen).toBe('a');
  });

  it('写完 _manifest 后删旧一代失败：只记 cleanup_failed，这一份照样算做完', async () => {
    const s = setup({ notes: [note(A)] }, { tables: [t('notes')] });
    s.put(`${dir(A)}/a_notes.json.gz`);
    s.put(`${dir(A)}/${MANIFEST_FILE}`, gz({ gen: 'a' }));
    const remove = s.bucket.remove.bind(s.bucket);
    s.bucket.remove = async (paths) => { if (paths.some((p) => p.endsWith('a_notes.json.gz'))) throw new Error('storage'); await remove(paths); };
    const r = await s.call({ user_id: A });
    expect([r.status, (await r.json()).done]).toEqual([200, true]);
    expect(s.codes).toEqual(['cleanup_failed']);
    expect(manOf(s, A).gen).toBe('b');
  });
});

describe('backup-daily：正在做的认领标记（B7a 评审第 6 条、复审第 3、4 条、收口第 1 条：原子创建）', () => {
  const chainRows = () => ({ notes: Array.from({ length: 20 }, () => note(A, 'n'.repeat(400))) });
  const chainLim = { segmentRawBytes: 2000, firstPage: 5, page: 5 };

  it('标记没过期：start、retry、publish 都跳过，不算次数、不碰文件', async () => {
    const s = setup({ notes: [note(A)] }, { tables: [t('notes')] });
    s.put(mark(A, 3, 7), gz({ run_id: OTHER_RUN }), NOW - 60_000);
    for (const mode of ['start', 'retry', 'publish']) {
      expect(await (await s.call({ user_id: A, mode })).json()).toEqual({ ok: true, skipped: 'running', date: DATE });
    }
    expect([s.rates.length, s.uploads.length, s.creates.length, s.removed.length]).toEqual([0, 0, 0, 0]);
  });

  it('最新的标记过期（超过 runningTtlMs）或时刻读不出来：建下一个轮次号接管，照常从头做，做完全部标记删掉', async () => {
    for (const at of [NOW - BACKUP_LIMITS.runningTtlMs - 1, Number.NaN]) {
      const s = setup({ notes: [note(A)] }, { tables: [t('notes')] });
      s.files.set(mark(A, 2, 5), { body: gz({ run_id: OTHER_RUN }), contentType: GZIP, updatedAt: Number.isNaN(at) ? 'bad' : new Date(at).toISOString() });
      expect((await (await s.call({ user_id: A })).json()).done).toBe(true);
      expect(s.creates).toEqual([mark(A, 3, 0)]);
      expect([...s.files.keys()].filter(isMark)).toEqual([]);
    }
  });

  it('两轮同时开始（都没看到标记）：同一个编号只有一轮建成，另一轮 skipped: running，不读库、不删文件、不写数据', async () => {
    const s = setup({ notes: [note(A)] }, { tables: [t('notes')] });
    s.put(`${dir(A)}/b_notes.3.json.gz`);   // 上一轮没做完的残片：输的那一轮不许删
    const create = s.bucket.create.bind(s.bucket);
    // 另一轮恰好先一步建成了同一个编号（像 Storage 并发上传同一个名字，只有一个成功）
    s.bucket.create = async (p, body, opts) => { if (p === mark(A)) s.put(p, gz({ run_id: OTHER_RUN })); return create(p, body, opts); };
    expect(await (await s.call({ user_id: A })).json()).toEqual({ ok: true, skipped: 'running', date: DATE });
    expect([s.reads, s.removed, s.uploads]).toEqual([[], [], []]);
    expect(s.files.has(`${dir(A)}/b_notes.3.json.gz`)).toBe(true);
  });

  it('真并发：同一个人同时发两次（Promise.all），只有一轮写数据和 _manifest，另一轮 skipped: running', async () => {
    const s = setup({ notes: [note(A), note(A)] }, { tables: [t('notes')] });
    const rs = await Promise.all([s.call({ user_id: A }), s.call({ user_id: A, mode: 'publish' })]);
    const out = await Promise.all(rs.map((r) => r.json()));
    expect(out.filter((o) => o.done === true).length).toBe(1);
    expect(out.filter((o) => o.skipped === 'running').length).toBe(1);
    expect(s.uploads.filter((p) => p.endsWith('_notes.json.gz'))).toEqual([`${dir(A)}/a_notes.json.gz`]);
    expect(s.creates.filter((p) => p === mark(A)).length).toBe(2);
  });

  it('两边同时接管过期的一轮：抢同一个新轮次号，只有一边建成', async () => {
    const s = setup({ notes: [note(A)] }, { tables: [t('notes')] });
    s.put(mark(A, 4, 2), gz({ run_id: OTHER_RUN }), NOW - BACKUP_LIMITS.runningTtlMs - 1);
    const rs = await Promise.all([s.call({ user_id: A }), s.call({ user_id: A, mode: 'publish' })]);
    const out = await Promise.all(rs.map((r) => r.json()));
    expect(out.map((o) => o.done === true || o.skipped).sort()).toEqual([true, 'running'].sort());
    expect(s.creates.filter((p) => p === mark(A, 5, 0)).length).toBe(2);
  });

  it('接力的一段：开头标记换成了别的 run_id、被删了、或有更大的轮次（被接管）：superseded，不读库、不建标记', async () => {
    for (const how of ['other_run', 'gone', 'newer_epoch'] as const) {
      const s = setup(chainRows(), { tables: [t('notes')], limits: chainLim });
      const b = await nextBody(s);
      if (how === 'other_run') s.put(mark(A), gz({ run_id: OTHER_RUN }));
      if (how === 'gone') s.files.delete(mark(A));
      if (how === 'newer_epoch') s.put(mark(A, 2, 0), gz({ run_id: OTHER_RUN }));
      const [reads, creates] = [s.reads.length, s.creates.length];
      expect(await (await s.call(b)).json()).toEqual({ ok: true, skipped: 'superseded' });
      expect([s.reads.length, s.creates.length]).toEqual([reads, creates]);
    }
  });

  it('接力每段开头建一个新标记（编号 = 轮次 × 1000 + 段号，续上有效期），做完全删', async () => {
    const s = setup(chainRows(), { tables: [t('notes')], limits: chainLim });
    await s.call({ user_id: A });
    await s.drain();
    expect(s.chained.length).toBeGreaterThan(1);
    expect(s.creates).toEqual(Array.from({ length: s.chained.length + 1 }, (_, k) => mark(A, 1, k)));
    expect(gun(s.files.get(`${dir(A)}/${MANIFEST_FILE}`)?.body ?? new Uint8Array())).toMatchObject({ run_id: RUN });
    expect([...s.files.keys()].filter(isMark)).toEqual([]);
  });

  it('同一段被重发两份：第二份建不成这一段的标记，superseded，不读库不写文件', async () => {
    const s = setup(chainRows(), { tables: [t('notes')], limits: chainLim });
    const b = await nextBody(s);
    s.deps.next = async () => 200;
    expect((await s.call(b)).status).toBe(200);
    expect(s.files.has(mark(A, 1, b.state.k))).toBe(true);
    const [reads, uploads] = [s.reads.length, s.uploads.length];
    expect(await (await s.call(b)).json()).toEqual({ ok: true, skipped: 'superseded' });
    expect([s.reads.length, s.uploads.length]).toEqual([reads, uploads]);
  });

  it('同一段的两份真并发（Promise.all）：只有一份读库写文件', async () => {
    const s = setup(chainRows(), { tables: [t('notes')], limits: chainLim });
    const b = await nextBody(s);
    s.deps.next = async () => 200;
    const reads = s.reads.length;
    const out = await Promise.all((await Promise.all([s.call(b), s.call(b)])).map((r) => r.json()));
    expect(out.filter((o) => o.skipped === 'superseded').length).toBe(1);
    expect(s.reads.length - reads).toBeGreaterThan(0);
    const one = s.reads.length - reads;
    // 再单跑一份同样的 state（第三份）：一行都不读，证明上面多出来的读全是一份做的
    await s.call(b);
    expect(s.reads.length - reads).toBe(one);
  });

  it('做完全删以后同一个轮次号被下一轮重新用了：旧一轮迟到的一段认得出不是自己的（run_id 对不上），superseded', async () => {
    const s = setup(chainRows(), { tables: [t('notes')], limits: chainLim });
    const b = await nextBody(s);
    for (const p of [...s.files.keys()].filter(isMark)) s.files.delete(p);
    s.put(mark(A), gz({ run_id: OTHER_RUN }));   // 下一轮又从轮次 1 开始
    expect(await (await s.call(b)).json()).toEqual({ ok: true, skipped: 'superseded' });
    expect(s.files.has(mark(A, 1, b.state.k))).toBe(false);   // 没在别人的轮次里占段号
  });

  it('只有一段、跑的时候被新一轮接管：写 _manifest 前核对不过，superseded，不写 _manifest、不删别人的标记', async () => {
    const s = setup({ notes: [note(A)] }, { tables: [t('notes')] });
    const read = s.store.readPage.bind(s.store);
    s.store.readPage = async (...a) => { s.put(mark(A, 2, 0), gz({ run_id: OTHER_RUN })); return read(...a); };
    expect(await (await s.call({ user_id: A })).json()).toEqual({ ok: true, skipped: 'superseded' });
    expect(s.files.has(`${dir(A)}/${MANIFEST_FILE}`)).toBe(false);
    expect(s.files.has(mark(A, 2, 0))).toBe(true);
    expect(s.beats).toEqual([]);
  });

  it('建标记时 Storage 出别的错（不是“已存在”）：503，不当成别人在做', async () => {
    const s = setup({ notes: [note(A)] }, { tables: [t('notes')] });
    s.bucket.create = async () => { throw new Error('storage'); };
    expect((await s.call({ user_id: A })).status).toBe(503);
    expect(s.codes).toEqual(['store_error']);
    expect(s.reads).toEqual([]);
  });
});

describe('backup-daily：只写当天，不删别的日期（保留期归 storage-sweep，B7a 收口第 2 条）', () => {
  it('写完当天 _manifest 后，这个人以前的日期目录一个不动（过期的由 storage-sweep 统一删，含停用账号的）', async () => {
    const s = setup({ notes: [note(A)] }, { tables: [t('notes')] });
    for (const d of ['2026-11-20', '2026-11-26']) {
      s.put(`${d}/${A}/${MANIFEST_FILE}`);
      s.put(`${d}/${A}/a_notes.json.gz`);
    }
    expect((await (await s.call({ user_id: A })).json()).done).toBe(true);
    expect([...new Set([...s.files.keys()].map((p) => p.split('/')[0]))].sort()).toEqual(['2026-11-20', '2026-11-26', DATE]);
    expect(s.codes).toEqual([]);
  });
});

describe('backup-daily：补跑、次数上限', () => {
  it('补跑（mode: retry）：当天已有 _manifest 跳过、不算次数；没有就从头做', async () => {
    const s = setup({ notes: [note(A)] }, { tables: [t('notes')] });
    s.put(`${dir(A)}/${MANIFEST_FILE}`);
    expect(await (await s.call({ user_id: A, mode: 'retry' })).json()).toEqual({ ok: true, skipped: 'done', date: DATE });
    expect([s.rates.length, s.uploads.length]).toEqual([0, 0]);
    s.files.clear();
    expect((await (await s.call({ user_id: A, mode: 'retry' })).json()).done).toBe(true);
  });

  it('次数到上限回 429；start、retry 合计一个上限，publish 另算一个（发布前触发不占每天的次数）', async () => {
    const s = setup({ notes: [note(A)] }, { tables: [t('notes')] });
    await s.call({ user_id: A });
    await s.call({ user_id: A, mode: 'publish' });
    expect(s.rates).toEqual([
      { key: expect.stringContaining('backup-daily'), limit: BACKUP_LIMITS.startDailyLimit },
      { key: expect.stringContaining('backup-daily-publish'), limit: BACKUP_LIMITS.publishDailyLimit },
    ]);
    expect(s.rates.every((r) => r.key.includes(A))).toBe(true);
    expect(s.rates[0]?.key).not.toContain('publish');
    s.deny();
    s.setNow(NOW + 60_000);
    expect((await s.call({ user_id: A })).status).toBe(429);
    expect((await s.call({ user_id: A, mode: 'publish' })).status).toBe(429);
  });
});

describe('backup-daily：接力的进度逐项校验', () => {
  const okState = { r: RUN, e: 1, d: DATE, s: NOW, g: 'a', k: 1, t: 1, after: null, n: 0, p: 0, rows: [1], files: [] };
  it('合格的进度接着跑；多字段、日期和开始时刻对不上、过期、代不对、表序号越界、after 不是 uuid、rows 长度不对、文件名不合格、轮次不对都回 400 且不读库', async () => {
    const s = setup({ profiles: [{ user_id: A }], notes: [note(A)] });
    s.put(mark(A), gz({ run_id: RUN }));
    expect((await s.call({ user_id: A, state: okState })).status).toBe(200);
    const reads = s.reads.length;
    const bad = [
      { ...okState, extra: 1 },
      { ...okState, d: '2026-12-01' },
      { ...okState, s: NOW + 1 },
      { ...okState, s: NOW - BACKUP_LIMITS.runTtlMs - 1, d: backupDate(NOW - BACKUP_LIMITS.runTtlMs - 1) },
      { ...okState, g: 'c' },
      { ...okState, t: 4, rows: [1, 1, 1, 1] },
      { ...okState, after: 'not-a-uuid' },
      { ...okState, rows: [] },
      { ...okState, r: 'x' },
      { ...okState, files: [{ t: 0, name: '../x.json.gz', bytes: 1, sha256: '0'.repeat(64) }] },
      { ...okState, files: [{ t: 0, name: 'notes.json.gz', bytes: 1, sha256: '0'.repeat(64) }] },
      { ...okState, files: [{ t: 0, name: 'b_notes.json.gz', bytes: 1, sha256: '0'.repeat(64) }] },
      { ...okState, files: [{ t: 2, name: 'a_notes.json.gz', bytes: 1, sha256: '0'.repeat(64) }] },
      { ...okState, k: BACKUP_LIMITS.maxSegments + 1 },
      { ...okState, e: 0 },
      { ...okState, e: 1_000_000 },
      { ...okState, e: '1' },
    ];
    for (const state of bad) expect((await s.call({ user_id: A, state })).status).toBe(400);
    expect(s.reads.length).toBe(reads);
  });

  it('段数到上限算异常：503、记 too_many_segments、不读库', async () => {
    const s = setup({ notes: [note(A)] });
    s.put(mark(A), gz({ run_id: RUN }));
    const r = await s.call({ user_id: A, state: { ...okState, k: BACKUP_LIMITS.maxSegments } });
    expect(r.status).toBe(503);
    expect(s.codes).toContain('too_many_segments');
    expect(s.reads.length).toBe(0);
  });
});

describe('backup-daily：数据异常不写 _manifest', () => {
  const noData = (s: ReturnType<typeof setup>) => s.uploads.filter((p) => !isMark(p));
  it('读回来的行不是这个人的：503、backup_foreign_row、没有 _manifest', async () => {
    const s = setup({ notes: [note(A)] }, { tables: [t('notes')] });
    s.store.readPage = async () => [{ id: id(), user_id: B }];
    expect((await s.call({ user_id: A })).status).toBe(503);
    expect(s.codes).toEqual(['backup_foreign_row']);
    expect(noData(s)).toEqual([]);
  });
  it('主键不往前走（库返回重复页）：backup_bad_page_key，不死循环', async () => {
    const r1 = note(A);
    const s = setup({}, { tables: [t('notes')], limits: { firstPage: 1, page: 1 } });
    s.store.readPage = async () => [r1];
    expect((await s.call({ user_id: A })).status).toBe(503);
    expect(s.codes).toEqual(['backup_bad_page_key']);
  });
  it('行数超过表上限：backup_too_many_rows', async () => {
    const s = setup({ notes: [note(A), note(A), note(A)] }, { tables: [t('notes', { maxRows: 2 })] });
    expect((await s.call({ user_id: A })).status).toBe(503);
    expect(s.codes).toEqual(['backup_too_many_rows']);
  });
  it('单个文件压缩后超上限：backup_file_too_large，不上传', async () => {
    const s = setup({ notes: [note(A, 'q'.repeat(5000))] }, { tables: [t('notes')], limits: { maxFileGzBytes: 20 } });
    expect((await s.call({ user_id: A })).status).toBe(503);
    expect(s.codes).toEqual(['backup_file_too_large']);
    expect(noData(s)).toEqual([]);
  });
  it('库出错：503 store_error；日志里没有 user_id、没有行内容', async () => {
    const s = setup({ notes: [note(A, 'secret-body')] }, { tables: [t('notes')] });
    s.store.readPage = async () => { throw new Error(`boom ${A} secret-body`); };
    expect((await s.call({ user_id: A })).status).toBe(503);
    expect(s.codes).toEqual(['store_error']);
    expect(s.codes.join(' ')).not.toContain(A);
  });
});

describe('backup-daily：发下一段', () => {
  const rows = () => ({ notes: Array.from({ length: 20 }, () => note(A, 'n'.repeat(400))) });
  const lim = { segmentRawBytes: 2000, firstPage: 5, page: 5 };
  it('发不出去重试一次，还不行记 chain_broken（这一天没有新的 _manifest，等标记过期后 02:30 补跑）', async () => {
    let calls = 0;
    const s = setup(rows(), { tables: [t('notes')], limits: lim, next: async () => { calls++; throw new Error('net'); } });
    await s.call({ user_id: A });
    await s.drain();
    expect(calls).toBe(2);
    expect(s.codes).toEqual(['next_failed', 'next_failed', 'chain_broken']);
    expect(s.files.has(`${dir(A)}/${MANIFEST_FILE}`)).toBe(false);
  });
  it('下一段回 400、401 不重试（进度或密钥不对，重试也一样）；回 503 重试一次', async () => {
    let calls = 0;
    const s = setup(rows(), { tables: [t('notes')], limits: lim, next: async () => { calls++; return 401; } });
    await s.call({ user_id: A });
    await s.drain();
    expect(calls).toBe(1);
    let c2 = 0;
    const s2 = setup(rows(), { tables: [t('notes')], limits: lim, next: async () => { c2++; return 503; } });
    await s2.call({ user_id: A });
    await s2.drain();
    expect(c2).toBe(2);
  });
  it('第一次失败、重试回 2xx：记 next_retry_ok（失败那次可能已建好标记、重试回 superseded，这一轮会静默断掉，留个码好查；复查第二轮第 2 条）', async () => {
    let calls = 0;
    const s = setup(rows(), { tables: [t('notes')], limits: lim, next: async () => (++calls === 1 ? 503 : 200) });
    await s.call({ user_id: A });
    await s.drain();
    expect(calls).toBe(2);
    expect(s.codes).toEqual(['next_status:503', 'next_retry_ok']);
  });
  it('接力带的进度经得起 JSON 来回（下一段收到的就是 state，k 加一）', async () => {
    const s = setup(rows(), { tables: [t('notes')], limits: lim, next: async () => 200 });
    const b = await nextBody(s);
    expect(b.user_id).toBe(A);
    expect(b.state).toMatchObject({ r: RUN, d: DATE, s: NOW, g: 'a', k: 1, t: 0, p: 1 });
    expect(JSON.parse(JSON.stringify(b))).toEqual(b);
  });
});

describe('backup-daily：日期和真清单', () => {
  it('日期按首尔：UTC 14:59 还是前一天，15:00 起算第二天', () => {
    expect(backupDate(Date.UTC(2026, 11, 1, 14, 59))).toBe('2026-12-01');
    expect(backupDate(Date.UTC(2026, 11, 1, 15, 0))).toBe('2026-12-02');
  });

  it('真清单里 backup: \'json\' 的表都有主键说明（app_config 没有用户数据跳过；logs 不进备份；ai_memories 负责人 11-26 定进备份），顺序照清单', () => {
    const tables = backupTablesOf(allManifests);
    const expected = allManifests.flatMap((m) => m.tables).filter((x) => x.backup === 'json' && !x.noUserData).map((x) => x.name);
    expect(tables.map((x) => x.name)).toEqual(expected);
    expect(tables.map((x) => x.name)).not.toContain('app_config');
    expect(tables.map((x) => x.name)).not.toContain('logs');
    expect(new Set(tables.map((x) => x.name))).toEqual(new Set(TABLE_KEYS.keys()));
    expect(tables.find((x) => x.name === 'invites')).toMatchObject({ lookupCol: 'created_by', keyType: 'text' });
    expect(tables.find((x) => x.name === 'vault_ai')).toMatchObject({ conflict: ['kind', 'source_id'] });
    // service role 没有表级权限的五张，经 private.backup_read 读（迁移 20261126130000 的 case 里也是这五张）
    expect(tables.filter((x) => x.rpc).map((x) => x.name).sort()).toEqual(['ai_memories', 'device_secrets', 'vault', 'vault_ai', 'vault_credentials']);
    expect(tables.find((x) => x.name === 'ai_memories')).toMatchObject({ schema: 'private', rpc: true });
  });

  it('清单新加 backup: \'json\' 的表、TABLE_KEYS 没写：直接报错，不会悄悄漏备份', () => {
    const extra = [{ tables: [{ name: 'brand_new', schema: 'public' as const, backup: 'json', userLookup: { by: 'column', col: 'user_id' } }] }];
    expect(() => backupTablesOf(extra)).toThrow('backup_table_keys:brand_new');
    const global = [{ tables: [{ name: 'other_cfg', schema: 'public' as const, backup: 'json', noUserData: true as const }] }];
    expect(() => backupTablesOf(global)).toThrow('backup_table_no_user_data:other_cfg');
  });
});
