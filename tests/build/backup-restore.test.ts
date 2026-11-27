// tools/backup/restore-lib.mjs（上线与回滚手册第 3 层第 5 步；架构第 10 节；TC-B7a-23 恢复一半、TC-B7a-10 能自动化的部分）。
// 证明：用 backup-daily 真的 core 做一份切过片的备份，再按 _manifest 拼回、在一个事务里写进假的库，行数和内容和原表一致；
// 试运行一条不写；库里多出来的行不删、只报条数；凭据类表默认不写、--only 点名才写（B7a 评审第 12 条）；
// 主键以外的唯一索引（同一句 AI 记忆、同名分类、同一个设置 key）备份占先、指着占位行的引用一个不漏地改指，不整体回退；
// 文件坏了、缺切片、混进别人的行、行数对不上、项目不一致都整体拒绝、一条不写；写库中途出错整个事务回退；
// sqlClient 拼的语句值都走参数、冲突键是清单里的主键。真库上的一次完整链路在 B7a 交回报告里（lemo-e2e）。
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { handle, type BackupFiles, type BackupStore, type BackupTable, type ContinueBody, type Deps } from '../../supabase/functions/backup-daily/core.ts';
import { readFileSync, readdirSync } from 'node:fs';
import { MERGE_DISMISSED_KEY, MERGE_SUGGEST_KEY } from '../../shared/logic/notes/category-merge.ts';
import { BATCH_ROWS, DEFAULT_SKIP, KEEP_LIVE, RestoreError, SECOND_UNIQUE, batches, dbUrlFromEnv, loadBackup, parseArgs, restore, sqlClient, targetOfDbUrl, uniqueRowsOf } from '../../tools/backup/restore-lib.mjs';

const SECRET = 's'.repeat(40);
const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const REF = 'abcdefghijklmnopqrst';
const NOW = Date.UTC(2026, 11, 1, 15, 30);
type Row = Record<string, unknown>;

const TABLES: BackupTable[] = [
  { name: 'profiles', schema: 'public', lookupCol: 'user_id', keyCol: 'user_id', keyType: 'self', conflict: ['user_id'], maxRows: 1 },
  { name: 'notes', schema: 'public', lookupCol: 'user_id', keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: 25_000 },
  { name: 'invites', schema: 'public', lookupCol: 'created_by', keyCol: 'code_hash', keyType: 'text', conflict: ['code_hash'], maxRows: 5000 },
  { name: 'vault_ai', schema: 'private', lookupCol: 'user_id', keyCol: 'source_id', keyType: 'uuid', conflict: ['kind', 'source_id'], maxRows: 50_000, rpc: true },
  { name: 'vault_credentials', schema: 'private', lookupCol: 'user_id', keyCol: 'credential_id', keyType: 'text', conflict: ['credential_id'], maxRows: 1000, rpc: true },
];
/** 假库里每张表的列（默认就是样例数据用到的全部列） */
const ALL_COLS = ['id', 'user_id', 'kind', 'source_id', 'code_hash', 'created_by', 'rev', 'body', 'tz', 'avatar_id', 'used', 'enc', 'credential_id', 'public_key'];
const NO_CRED = ['profiles', 'notes', 'vault_ai'];
let seq = 0;
const id = () => `00000000-0000-4000-8000-${(++seq).toString(16).padStart(12, '0')}`;

/** 用 backup-daily 的 core 真做一份备份（小预算，notes 会切成好几片），返回这个人目录下的文件 */
async function makeBackup(data: Record<string, Row[]>, user: string, project = REF, tables: BackupTable[] = TABLES): Promise<Map<string, Buffer>> {
  const files = new Map<string, Uint8Array>();
  const store: BackupStore = {
    async readPage(t, u, after, limit) {
      const k = (r: Row) => String(r[t.keyCol]);
      return (data[t.name] ?? []).filter((r) => r[t.lookupCol] === u && (after === null || k(r) > String(after))).sort((x, y) => (k(x) < k(y) ? -1 : 1)).slice(0, limit);
    },
    async writeHeartbeat() {},
    async takeRate() { return true; },
  };
  const bucket: BackupFiles = {
    async list(dir) { return [...files.keys()].filter((p) => p.startsWith(`${dir}/`)).map((p) => ({ name: p.slice(dir.length + 1), updatedAt: null })); },
    async read(path) { return files.get(path) ?? null; },
    async remove(paths) { for (const p of paths) files.delete(p); },
    async upload(path, body) { files.set(path, body); },
    async create(path, body) { if (files.has(path)) return false; files.set(path, body); return true; },
  };
  const pending: Promise<unknown>[] = [];
  const deps: Deps = {
    cronSecret: SECRET, store, files: bucket, tables, isUsable: async () => true,
    next: async (b: ContinueBody) => (await call(b)).status, background: (p) => { pending.push(p); },
    now: () => NOW, log: () => {}, project, limits: { segmentRawBytes: 3000, firstPage: 5, page: 8 },
  };
  const call = (body: unknown) => handle(new Request('https://x', { method: 'POST', headers: { 'x-cron-secret': SECRET }, body: JSON.stringify(body) }), deps);
  expect((await call({ user_id: user })).status).toBe(200);
  while (pending.length) await pending.shift();
  const prefix = `2026-12-02/${user}/`;
  return new Map([...files].filter(([p]) => p.startsWith(prefix)).map(([p, b]) => [p.slice(prefix.length), Buffer.from(b)]));
}

const reader = (m: Map<string, Buffer>) => (name: string) => {
  const b = m.get(name);
  if (!b) throw new Error('ENOENT');
  return b;
};
const manifestOf = (files: Map<string, Buffer>) => JSON.parse(gunzipSync(files.get('_manifest.json.gz') ?? Buffer.alloc(0)).toString('utf8'));

/**
 * 假的事务库：按表存行；transaction 先拷一份，fn 抛错就丢掉（整体回退），不抛才换上。
 * 记下每次写的表、主键、列，和 restore-lib 的 sqlClient 同一组方法（keys、columns、upsert、conflicts、resolve、refCount、repoint）。
 * SECOND_UNIQUE 的三张表照真库的唯一索引拦（本机 lemo-e2e 实测撞的就是这三条）：ai_memories (user_id, norm)、
 * categories (user_id, vault, lower(name)) 都只管没删的行；settings (user_id, key) 不分删没删。
 */
type Spec = { index: string; cols: readonly { col: string; lower?: boolean }[]; partial: string | null; resolve: string };
type Ref = { kind: string; table: string; col?: string; keys?: readonly string[] };
type Pair = { old: string; new: string };
const alive = (spec: Spec, r: Row) => spec.partial === null || r[spec.partial] === null || r[spec.partial] === undefined;
const uniqOf = (spec: Spec, r: Row) => JSON.stringify([String(r['user_id']), ...spec.cols.map((c) => (c.lower ? String(r[c.col]).toLowerCase() : String(r[c.col])))]);
type Keep = { cols?: readonly string[]; bump?: string; all?: boolean };
function fakeDb(initial: Record<string, Row[]> = {}, opts: { failOn?: string; cols?: Record<string, string[]>; quota?: { exempt: boolean; rowQuota: string[] } } = {}) {
  let db = new Map<string, Row[]>(Object.entries(initial).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
  const writes: { table: string; schema: string; key: string[]; cols: string[]; rows: number }[] = [];
  /** 被软删或删掉的占位行，记成“表:id” */
  const resolved: string[] = [];
  let txCount = 0;
  const client = {
    async transaction(fn: (tx: unknown) => Promise<unknown>) {
      txCount++;
      const work = new Map([...db].map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
      const tx = {
        async keys(t: { name: string; key: string[]; lookup: string }, u: string) {
          return new Set((work.get(t.name) ?? []).filter((r) => String(r[t.lookup]) === u).map((r) => JSON.stringify(t.key.map((k) => String(r[k])))));
        },
        async columns(t: { name: string }) {
          // opts.cols 可以模拟“库里比备份少一列”（生成列、已删的列）
          return { cols: opts.cols?.[t.name] ?? ALL_COLS, identityAlways: false };
        },
        async quotaContext() { return opts.quota ?? { exempt: true, rowQuota: [] }; },
        async todoItems(u: string) {
          return (work.get('todo_items') ?? []).filter((r) => r['user_id'] === u)
            .map((r) => ({ id: String(r['id']), todo_id: String(r['todo_id']), visible: (r['deleted_at'] ?? null) === null && r['undone'] !== true }));
        },
        async upsert(t: { name: string; schema: string; key: string[] }, cols: string[], _ident: boolean, rows: Row[]) {
          writes.push({ table: t.name, schema: t.schema, key: [...t.key], cols: [...cols], rows: rows.length });
          if (t.name === opts.failOn) throw Object.assign(new Error('duplicate key value violates unique constraint (secret row text)'), { code: '23505' });
          const cur = work.get(t.name) ?? [];
          // 和 sqlClient 的 upsert 同一个意思（KEEP_LIVE）：cols 不覆盖、bump 插入加 1 冲突取 max(库里 + 1, 备份 + 1)、all 整行不覆盖
          const keep: Keep | undefined = (KEEP_LIVE as Record<string, Keep>)[t.name];
          for (const r of rows) {
            const kept: Row = Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]]));
            if (keep?.bump && keep.bump in kept) kept[keep.bump] = Number(kept[keep.bump]) + 1;
            const i = cur.findIndex((x) => t.key.every((k) => x[k] === r[k]));
            const was = cur[i];
            if (i < 0 || !was) { cur.push(kept); continue; }
            if (keep?.all) continue;
            const upd: Row = Object.fromEntries(Object.entries(kept).filter(([c]) => !(keep?.cols ?? []).includes(c)));
            if (keep?.bump && keep.bump in upd) upd[keep.bump] = Math.max(Number(was[keep.bump]) + 1, Number(upd[keep.bump]));
            cur[i] = { ...was, ...upd };
          }
          // 和真库一样：主键以外的唯一索引撞了就 23505，带约束名
          const spec: Spec | undefined = (SECOND_UNIQUE as Record<string, Spec>)[t.name];
          if (spec) {
            const seen = new Set<string>();
            for (const x of cur.filter((m) => alive(spec, m))) {
              const k = uniqOf(spec, x);
              if (seen.has(k)) throw Object.assign(new Error(`duplicate key value violates unique constraint "${spec.index}" (secret row text)`), { code: '23505', constraint_name: spec.index });
              seen.add(k);
            }
          }
          work.set(t.name, cur);
        },
        async conflicts(t: { name: string; key: string[]; lookup: string }, spec: Spec, u: string, rows: Row[]) {
          const k = t.key[0] ?? '';
          const out: Pair[] = [];
          for (const m of (work.get(t.name) ?? []).filter((x) => String(x[t.lookup]) === u && alive(spec, x))) {
            for (const x of rows) if (uniqOf(spec, { ...x, user_id: u }) === uniqOf(spec, m) && String(m[k]) !== x[k]) out.push({ old: String(m[k]), new: String(x[k]) });
          }
          return out;
        },
        async resolve(t: { name: string; key: string[]; lookup: string }, spec: Spec, u: string, ids: string[]) {
          const k = t.key[0] ?? '';
          const cur = work.get(t.name) ?? [];
          const hit = cur.filter((m) => String(m[t.lookup]) === u && ids.includes(String(m[k])) && (spec.resolve === 'delete' || alive(spec, m)));
          if (spec.resolve === 'delete') work.set(t.name, cur.filter((m) => !hit.includes(m)));
          else for (const m of hit) m[spec.partial ?? ''] = NOW;
          resolved.push(...hit.map((m) => `${t.name}:${String(m[k])}`));
          return hit.length;
        },
        async refCount(ref: Ref, u: string, map: Pair[]) {
          return refHits(work, ref, u, map).length;
        },
        async repoint(ref: Ref, u: string, map: Pair[]) {
          const swap = (v: unknown) => map.find((p) => p.old === v)?.new ?? v;
          const hit = refHits(work, ref, u, map);
          for (const r of hit) {
            if (ref.kind === 'pairs') r['value'] = (r['value'] as unknown[]).map((p) => (Array.isArray(p) ? p.map(swap) : p));
            else r[ref.col ?? ''] = swap(r[ref.col ?? '']);
          }
          return hit.length;
        },
      };
      const out = await fn(tx);
      db = work;
      return out;
    },
  };
  return { get db() { return db; }, writes, resolved, client, get txCount() { return txCount; } };
}
/** 不处理占位行的假库（模拟修复前）：resolve 一条不动 */
const noResolve = (r: ReturnType<typeof fakeDb>) => ({ transaction: (fn: (tx: unknown) => Promise<unknown>) => r.client.transaction((tx) => fn({ ...(tx as object), resolve: async () => 0 })) });
/** 和 restore-lib 的 refCount、repoint 同一个意思：这个人的行里，引用列（或 settings 这几个 key 的 [id, id] 数组）指着某个 old 的 */
function refHits(work: Map<string, Row[]>, ref: Ref, u: string, map: Pair[]) {
  const olds = new Set(map.map((p) => p.old));
  return (work.get(ref.table) ?? []).filter((r) => String(r['user_id']) === u && (ref.kind === 'pairs'
    ? (ref.keys ?? []).includes(String(r['key'])) && Array.isArray(r['value']) && (r['value'] as unknown[]).some((p) => Array.isArray(p) && p.some((v) => olds.has(String(v))))
    : olds.has(String(r[ref.col ?? '']))));
}

function sample() {
  const notes = Array.from({ length: 60 }, (_, i) => ({ id: id(), user_id: A, rev: i + 1, body: `第 ${i} 条 ${'字'.repeat(40)}` }));
  return {
    profiles: [{ user_id: A, tz: 'Asia/Seoul', avatar_id: null }, { user_id: B, tz: 'UTC', avatar_id: null }],
    notes: [...notes, { id: id(), user_id: B, rev: 1, body: 'B 的' }],
    invites: [{ code_hash: 'h-A-1', created_by: A, used: false }, { code_hash: 'h-B-1', created_by: B, used: true }],
    vault_ai: [{ kind: 'image', source_id: id(), user_id: A, enc: '\\x01' }, { kind: 'doc', source_id: id(), user_id: A, enc: '\\x02' }],
    vault_credentials: [{ credential_id: 'cred-a', user_id: A, public_key: '\\x0a0b' }],
  };
}

describe('restore-lib：参数和目标', () => {
  it('--user 要 uuid；--confirm、--only 照收；--url 不再收（连接串不进命令行）', () => {
    const ok = parseArgs(['--user', A, '--from', 'D:/x', '--dry-run', '--only', 'notes,profiles', '--confirm', REF]);
    expect(ok).toMatchObject({ user: A, from: 'D:/x', dryRun: true, only: ['notes', 'profiles'], confirm: REF });
    for (const bad of [['--user', 'x', '--from', 'd'], ['--user', A], ['--user', A, '--from', 'd', '--url', `https://${REF}.supabase.co`],
      ['--user', A, '--from', 'd', '--key', 'k'], ['--user', A, '--from', 'd', '--only', 'No-Such']]) {
      expect(() => parseArgs(bad), bad.join(' ')).toThrow(RestoreError);
    }
  });

  it('目标从连接串认：直连 db.<ref>.supabase.co、连接池用户名 postgres.<ref>、本机；别的一律不认', () => {
    expect([
      targetOfDbUrl(`postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`),
      targetOfDbUrl(`postgres://postgres.${REF}:pw@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres`),
      targetOfDbUrl('postgresql://postgres:postgres@127.0.0.1:55322/postgres'),
      targetOfDbUrl('postgresql://postgres:pw@evil.example:5432/postgres'),
      targetOfDbUrl(`https://${REF}.supabase.co`),
      targetOfDbUrl('postgres://postgres:pw@aws-0-x.pooler.supabase.com:5432/postgres'),
      targetOfDbUrl('not a url'),
    ]).toEqual([REF, REF, 'local', null, null, null, null]);
  });
});

describe('restore-lib：拼回和写回（TC-B7a-23、TC-B7a-10）', () => {
  it('TC-B7a-23 切过片的备份按 _manifest 拼回、在一个事务里写进空库，行数和内容和原表一致；B 的一行都没有；凭据类表默认不写', async () => {
    const data = sample();
    const files = await makeBackup(data, A);
    const gen = manifestOf(files).gen;
    expect([...files.keys()].filter((n) => n.startsWith(`${gen}_notes.`)).length).toBeGreaterThan(2);
    const backup = loadBackup(reader(files), A);
    expect(backup.tables.map((t: { name: string; rows: unknown[] }) => [t.name, t.rows.length])).toEqual([['profiles', 1], ['notes', 60], ['invites', 1], ['vault_ai', 2], ['vault_credentials', 1]]);
    const r = fakeDb();
    const { report, skipped } = await restore({ backup, userId: A, target: REF, client: r.client, dryRun: false, only: null });
    expect(report.map((x: { table: string; insert: number }) => [x.table, x.insert])).toEqual([['profiles', 1], ['notes', 60], ['vault_ai', 2]]);
    expect(skipped).toEqual(['invites', 'vault_credentials']);
    expect(r.txCount).toBe(1);
    const norm = (rows: Row[]) => [...rows].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
    for (const t of ['profiles', 'notes', 'vault_ai']) expect(norm(r.db.get(t) ?? [])).toEqual(norm((data as Record<string, Row[]>)[t]?.filter((x) => x.user_id === A) ?? []));
    expect(r.db.get('invites')).toBeUndefined();   // B7a 复审第 2 条：邀请码默认不恢复
    expect(r.db.get('vault_credentials')).toBeUndefined();
    // 写回顺序照清单（父表在前）；冲突键是清单的主键；private 表照写（直连，不放宽 service_role）
    expect([...new Set(r.writes.map((w) => w.table))]).toEqual(NO_CRED);
    expect(r.writes.find((w) => w.table === 'vault_ai')).toMatchObject({ schema: 'private', key: ['kind', 'source_id'] });
    expect(r.writes.find((w) => w.table === 'notes')).toMatchObject({ schema: 'public', key: ['id'] });
  });

  it('B7a 评审第 12 条：凭据类表默认跳过，--only 点名才写', async () => {
    expect([...DEFAULT_SKIP].sort()).toEqual(['admins', 'api_tokens', 'device_secrets', 'devices', 'invites', 'vault', 'vault_credentials']);
    const backup = loadBackup(reader(await makeBackup(sample(), A)), A);
    const r = fakeDb();
    const { skipped } = await restore({ backup, userId: A, target: REF, client: r.client, dryRun: false, only: ['vault_credentials'] });
    expect(skipped).toEqual([]);
    expect(r.db.get('vault_credentials')).toEqual([{ credential_id: 'cred-a', user_id: A, public_key: '\\x0a0b' }]);
    expect(r.db.get('notes')).toBeUndefined();
  });

  it('TC-B7a-10 恢复到被写坏的库：试运行一条不写、报出新增和覆盖；正式执行后备份里的行都回来，库里多出来的行不删', async () => {
    const data = sample();
    const backup = loadBackup(reader(await makeBackup(data, A)), A);
    const aNotes = data.notes.filter((n) => n.user_id === A);
    const extra = { id: id(), user_id: A, rev: 1, body: '备份之后新记的' };
    // 写坏：删掉 10 条、改坏 5 条、多出 1 条
    const broken = [...aNotes.slice(10, 15).map((n) => ({ ...n, body: '坏了' })), ...aNotes.slice(15), extra];
    const r = fakeDb({ notes: broken, profiles: [{ user_id: A, tz: 'X' }] });
    const dry = await restore({ backup, userId: A, target: REF, client: r.client, dryRun: true, only: ['notes'] });
    expect(dry.report).toEqual([{ table: 'notes', backup: 60, current: 51, insert: 10, overwrite: 50, extra: 1, retire: 0, repoint: 0, kept: 0 }]);
    expect(r.writes).toEqual([]);
    await restore({ backup, userId: A, target: REF, client: r.client, dryRun: false, only: ['notes'] });
    const after = r.db.get('notes') ?? [];
    expect(after.length).toBe(61);
    for (const n of aNotes) expect(after.find((x) => x.id === n.id)).toEqual(n);
    expect(after.find((x) => x.id === extra.id)).toEqual(extra);
    expect(r.db.get('profiles')).toEqual([{ user_id: A, tz: 'X' }]);   // --only 以外的表不动
  });

  it('只写库里有的列：备份里有、库里已经没有（或是生成列）的列不写', async () => {
    const backup = loadBackup(reader(await makeBackup(sample(), A)), A);
    const r = fakeDb({}, { cols: { notes: ['id', 'user_id', 'rev'] } });
    await restore({ backup, userId: A, target: REF, client: r.client, dryRun: false, only: ['notes'] });
    expect(r.writes.every((w) => w.cols.join() === 'id,user_id,rev')).toBe(true);
    expect(Object.keys(r.db.get('notes')?.[0] ?? {}).sort()).toEqual(['id', 'rev', 'user_id']);
  });

  it('B7a 遗留第 3 条：AI 记忆备份之后删了又记同一句话（norm 相同、id 不同）——库里那条先软删、备份占先，不再整体回退', async () => {
    const MEM: BackupTable[] = [{ name: 'ai_memories', schema: 'private', lookupCol: 'user_id', keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: 10_000, rpc: true }];
    const cols = { ai_memories: ['id', 'user_id', 'text', 'norm', 'created_at', 'updated_at', 'deleted_at'] };
    const mem = (i: string, norm: string, deleted: number | null, user = A) => ({ id: i, user_id: user, text: norm, norm, created_at: 1, updated_at: 1, deleted_at: deleted });
    const [Y, Z, W, X, V, BX] = [id(), id(), id(), id(), id(), id()];
    // 备份：Y“同一句”没删、Z“备份时已删”是删的、W 只在备份里
    const backup = loadBackup(reader(await makeBackup({ ai_memories: [mem(Y, '同一句', null), mem(Z, '备份时已删', 5), mem(W, '只在备份', null)] }, A, REF, MEM)), A);
    // 库里：Y 被删了还没过 1 天（软删留着）、之后又记了同一句话 X；V 和备份里删掉的 Z 同一句（备份里那条是删的，V 不动）；B 的同一句话不动
    const initial = { ai_memories: [mem(Y, '同一句', 3), mem(X, '同一句', null), mem(V, '备份时已删', null), mem(BX, '同一句', null, B)] };

    // 不先软删就会撞索引：报 db_write，带 sqlstate 和约束名，不带行内容，整体回退（本机 lemo-e2e 修复前实测同一条：23505 ai_memories_user_norm）
    const r0 = fakeDb(initial, { cols });
    const err = await restore({ backup, userId: A, target: REF, client: noResolve(r0), dryRun: false, only: null }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'db_write' });
    expect(String((err as Error).message)).toContain('23505 ai_memories_user_norm');
    expect(String((err as Error).message)).not.toContain('secret row text');
    expect(r0.db.get('ai_memories')).toEqual(initial.ai_memories);

    const r = fakeDb(initial, { cols });
    const dry = await restore({ backup, userId: A, target: REF, client: r.client, dryRun: true, only: null });
    expect(dry.report).toEqual([{ table: 'ai_memories', backup: 3, current: 3, insert: 2, overwrite: 1, extra: 2, retire: 1, repoint: 0, kept: 0 }]);
    expect(r.resolved).toEqual([]);
    expect(r.writes).toEqual([]);
    const said: string[] = [];
    await restore({ backup, userId: A, target: REF, client: r.client, dryRun: false, only: null, say: (s: string) => said.push(s) });
    expect(r.resolved).toEqual([`ai_memories:${X}`]);
    expect(said.some((s) => s.includes('库里有 1 条和备份里的行是同一句话、主键不同，先软删'))).toBe(true);
    const after = new Map((r.db.get('ai_memories') ?? []).map((m) => [m['id'], m['deleted_at']]));
    expect(Object.fromEntries([Y, Z, W, X, V, BX].map((k) => [k, after.get(k)]))).toEqual({ [Y]: null, [Z]: 5, [W]: null, [X]: NOW, [V]: null, [BX]: null });
  });

  describe('负责人 11-26：同名分类、同一个设置 key 也是备份占先，不整体回退', () => {
    const tbl = (name: string): BackupTable => ({ name, schema: 'public', lookupCol: 'user_id', keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: 10_000 });
    const T3 = ['settings', 'categories', 'notes'].map(tbl);   // 和真清单一样：settings、categories 在 notes 前面
    const cols = { settings: ['id', 'user_id', 'key', 'value', 'deleted_at'], categories: ['id', 'user_id', 'name', 'vault', 'merged_into', 'deleted_at'], notes: ['id', 'user_id', 'body', 'category_id'] };
    const cat = (i: string, name: string, extra: Row = {}) => ({ id: i, user_id: A, name, vault: false, merged_into: null, deleted_at: null, ...extra });
    const set = (i: string, key: string, value: unknown, extra: Row = {}) => ({ id: i, user_id: A, key, value, deleted_at: null, ...extra });
    const note = (i: string, category_id: string, user = A) => ({ id: i, user_id: user, body: '笔记', category_id });

    it('库里同名分类（大小写不同）先软删，笔记、merged_into、合并建议里指着它的全部改指到备份那条；同 key 的设置（含已软删的）先删；别人的行不动', async () => {
      const [Y, Z, X, AA, BX, N1, N2, N3, BN, SY, SF, SL, SLF, SX, SD, BS] = [id(), id(), id(), id(), id(), id(), id(), id(), id(), id(), id(), id(), id(), id(), id(), id()];
      const backup = loadBackup(reader(await makeBackup({
        settings: [set(SY, 'ui.theme', 'dark'), set(SF, 'ui.font', 'big')],
        categories: [cat(Y, 'work'), cat(Z, '学习')],
        notes: [note(N1, Y)],
      }, A, REF, T3)), A);
      // 库里：备份之后真删了 Y、又建了同名的 X“Work”；N2、N3 记在 X 下；AA 合并进了 X；合并建议里有 X；
      // 换设备后 ui.theme 新建了 SL、ui.font 的 SLF 已软删（settings 的约束不分删没删，照样撞）；B 的同名分类、合并建议里出现 X 的设置都不动
      const initial = {
        settings: [set(SL, 'ui.theme', 'light'), set(SLF, 'ui.font', 'small', { deleted_at: 5 }), set(SX, MERGE_SUGGEST_KEY, [[X, Z]]), set(SD, MERGE_DISMISSED_KEY, [[AA, X]]),
          set(BS, MERGE_SUGGEST_KEY, [[X, BX]], { user_id: B })],
        categories: [cat(X, 'Work'), cat(Z, '学习'), cat(AA, '杂项', { deleted_at: 5, merged_into: X }), cat(BX, 'work', { user_id: B })],
        notes: [note(N2, X), note(N3, X), note(BN, BX, B)],
      };
      // 不先处理就撞：settings 在前，报 settings 的约束；只恢复分类和笔记时报分类的约束。都整体回退（本机 lemo-e2e 修复前实测同样两条 23505）
      const r0 = fakeDb(initial, { cols });
      const e1 = await restore({ backup, userId: A, target: REF, client: noResolve(r0), dryRun: false, only: null }).catch((e: unknown) => e);
      expect(e1).toMatchObject({ code: 'db_write' });
      expect(String((e1 as Error).message)).toContain('23505 settings_user_id_key_key');
      const e2 = await restore({ backup, userId: A, target: REF, client: noResolve(r0), dryRun: false, only: ['categories', 'notes'] }).catch((e: unknown) => e);
      expect(String((e2 as Error).message)).toContain('23505 categories_user_vault_name_key');
      expect(String((e2 as Error).message)).not.toContain('secret row text');
      expect(Object.fromEntries(r0.db)).toEqual(initial);

      const r = fakeDb(initial, { cols });
      const dry = await restore({ backup, userId: A, target: REF, client: r.client, dryRun: true, only: null });
      expect(dry.report).toEqual([
        { table: 'settings', backup: 2, current: 4, insert: 2, overwrite: 0, extra: 4, retire: 2, repoint: 0, kept: 0 },
        { table: 'categories', backup: 2, current: 3, insert: 1, overwrite: 1, extra: 2, retire: 1, repoint: 5, kept: 0 },   // 笔记 2 + merged_into 1 + 合并建议 2
        { table: 'notes', backup: 1, current: 2, insert: 1, overwrite: 0, extra: 2, retire: 0, repoint: 0, kept: 0 },
      ]);
      expect([r.resolved, r.writes]).toEqual([[], []]);
      expect(Object.fromEntries(r.db)).toEqual(initial);

      const said: string[] = [];
      await restore({ backup, userId: A, target: REF, client: r.client, dryRun: false, only: null, say: (s: string) => said.push(s) });
      expect(r.txCount).toBe(2);
      expect(r.resolved).toEqual([`settings:${SL}`, `settings:${SLF}`, `categories:${X}`]);
      expect(said.filter((s) => s.includes('先删掉') || s.includes('先软删') || s.includes('改指'))).toEqual([
        '  settings：库里有 2 条和备份里的行是同一个设置 key、主键不同，先删掉（备份占先；事务还没提交）',
        '  categories：库里有 1 条和备份里的行是同名分类、主键不同，先软删（备份占先；事务还没提交）',
        '  categories：notes.category_id 里指着被处理那条的 2 行改指到备份里同名分类的那条（事务还没提交）',
        '  categories：categories.merged_into 里指着被处理那条的 1 行改指到备份里同名分类的那条（事务还没提交）',
        `  categories：settings 的 ${MERGE_SUGGEST_KEY}、${MERGE_DISMISSED_KEY} 里指着被处理那条的 2 行改指到备份里同名分类的那条（事务还没提交）`,
      ]);
      const by = (t: string) => new Map((r.db.get(t) ?? []).map((x) => [x['id'], x]));
      const s = by('settings');
      expect([SL, SLF].map((k) => s.has(k))).toEqual([false, false]);
      expect([SY, SF, SX, SD, BS].map((k) => s.get(k)?.['value'])).toEqual(['dark', 'big', [[Y, Z]], [[AA, Y]], [[X, BX]]]);
      const c = by('categories');
      expect([X, Y, Z, AA, BX].map((k) => [c.get(k)?.['deleted_at'], c.get(k)?.['merged_into']])).toEqual([[NOW, null], [null, null], [null, null], [5, Y], [null, null]]);
      const n = by('notes');
      expect([N1, N2, N3, BN].map((k) => n.get(k)?.['category_id'])).toEqual([Y, Y, Y, BX]);
    });

    it('占位的那条也在备份里（备份之后改了名）：先软删、紧接着按备份写回原样，不改指、不留软删', async () => {
      const [Y, X, N2] = [id(), id(), id()];
      const backup = loadBackup(reader(await makeBackup({ categories: [cat(Y, 'work'), cat(X, 'life')] }, A, REF, [tbl('categories')])), A);
      const r = fakeDb({ categories: [cat(X, 'Work')], notes: [note(N2, X)] }, { cols });
      const dry = await restore({ backup, userId: A, target: REF, client: r.client, dryRun: true, only: null });
      expect(dry.report).toEqual([{ table: 'categories', backup: 2, current: 1, insert: 1, overwrite: 1, extra: 0, retire: 1, repoint: 0, kept: 0 }]);
      await restore({ backup, userId: A, target: REF, client: r.client, dryRun: false, only: null });
      expect(r.resolved).toEqual([`categories:${X}`]);
      expect(r.db.get('categories')).toEqual([cat(X, 'life'), cat(Y, 'work')]);
      expect(r.db.get('notes')).toEqual([note(N2, X)]);
    });

    it('引用一个不漏：迁移里所有引用 categories 的外键、存分类 id 的列，和 shared 里存 [id, id] 的设置 key，都在 SECOND_UNIQUE.categories.refs 里', () => {
      const dir = new URL('../../supabase/migrations/', import.meta.url);
      const found = new Set<string>();
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
        const text = readFileSync(new URL(f, dir), 'utf8').replace(/--[^\n]*/g, '');
        for (const st of text.split(';')) {
          const table = /\b(?:create table|alter table)\s+(?:if not exists\s+)?(?:only\s+)?(?:public\.|private\.)?(\w+)/i.exec(st)?.[1];
          if (!table) continue;
          if (/references\s+(?:public\.)?categories\b/i.test(st)) {
            for (const m of st.matchAll(/foreign key\s*\((\w+)/gi)) found.add(`${table}.${m[1]}`);
            for (const m of st.matchAll(/(\w+)\s+uuid\b[^,]*references\s+(?:public\.)?categories\b/gi)) found.add(`${table}.${m[1]}`);
          }
          // 名字看得出存的是分类 id 的 uuid 列（没有外键的也算，例如 merged_into）
          for (const m of st.matchAll(/\b(\w*categor\w*|merged_into)\s+uuid\b/gi)) found.add(`${table}.${m[1]}`);
        }
      }
      const refs = SECOND_UNIQUE.categories.refs as readonly Ref[];
      expect([...found].sort()).toEqual(['categories.merged_into', 'notes.category_id']);
      expect(refs.filter((x) => x.kind === 'column').map((x) => `${x.table}.${x.col}`).sort()).toEqual([...found].sort());
      const keys = [...readFileSync(new URL('../../shared/logic/notes/category-merge.ts', import.meta.url), 'utf8').matchAll(/export const \w+_KEY = '([^']+)'/g)].map((m) => m[1]);
      expect(keys.sort()).toEqual([MERGE_DISMISSED_KEY, MERGE_SUGGEST_KEY].sort());
      expect(refs.filter((x) => x.kind === 'pairs').flatMap((x) => [...(x.keys ?? [])]).sort()).toEqual(keys);
      // 三条唯一索引在迁移里都找得到（settings 那条是建表时的 unique (user_id, key)，名字由库起）
      const all = readdirSync(dir).filter((x) => x.endsWith('.sql')).map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
      expect(all).toContain('create unique index ai_memories_user_norm on private.ai_memories (user_id, norm) where deleted_at is null');
      expect(all).toContain('create unique index categories_user_vault_name_key on public.categories (user_id, vault, lower(name)) where deleted_at is null');
      expect(all).toMatch(/key text not null, value jsonb not null, unique \(user_id, key\)/);
    });
  });

  it('按行数切批', () => {
    expect(batches(Array.from({ length: BATCH_ROWS * 2 + 1 }, (_, i) => ({ i }))).map((b: unknown[]) => b.length)).toEqual([BATCH_ROWS, BATCH_ROWS, 1]);
  });
});

describe('B7a 复审第 2 条：安全和同意状态保留库里现值', () => {
  const tb = (name: string, schema: 'public' | 'private', keyCol: string, keyType: BackupTable['keyType'], lookupCol = 'user_id'): BackupTable =>
    ({ name, schema, lookupCol, keyCol, keyType, conflict: [keyCol], maxRows: 10_000 });
  const T = [tb('profiles', 'public', 'user_id', 'self'), tb('settings', 'public', 'id', 'uuid'), tb('user_limits', 'private', 'user_id', 'self'),
    tb('vault', 'private', 'user_id', 'self'), tb('invites', 'private', 'code_hash', 'text', 'created_by')];
  const cols = {
    profiles: ['user_id', 'tz', 'disabled_at', 'disabled_reason', 'consent_ai_at', 'consent_policy_ver'], settings: ['id', 'user_id', 'key', 'value', 'deleted_at'],
    user_limits: ['user_id', 'media_mb'], vault: ['user_id', 'pin_hash', 'pin_epoch', 'fail_count', 'lock_level', 'locked_until'], invites: ['code_hash', 'created_by', 'max_uses', 'used_count'],
  };
  const [S1, S2, S3] = [id(), id(), id()];
  const data = {
    profiles: [{ user_id: A, tz: 'Asia/Seoul', disabled_at: null, disabled_reason: null, consent_ai_at: '2026-11-01T00:00:00Z', consent_policy_ver: 'v1' }],
    settings: [{ id: S1, user_id: A, key: 'ui.theme', value: 'dark', deleted_at: null }, { id: S2, user_id: A, key: 'ai.enabled', value: true, deleted_at: null },
      { id: S3, user_id: A, key: 'ai.vault', value: true, deleted_at: null }],
    user_limits: [{ user_id: A, media_mb: 500 }],
    vault: [{ user_id: A, pin_hash: 'old-hash', pin_epoch: 3, fail_count: 0, lock_level: 0, locked_until: null }],
    invites: [{ code_hash: 'h1', created_by: A, max_uses: 1, used_count: 0 }],
  };
  // 备份之后：管理员停用了账号、本人撤回了 AI 同意并关掉 AI、换过 PIN（epoch 5）还输错被锁、邀请码用掉了、上限被改小
  const live = {
    profiles: [{ user_id: A, tz: 'UTC', disabled_at: '2026-11-20T00:00:00Z', disabled_reason: 'admin', consent_ai_at: null, consent_policy_ver: null }],
    settings: [{ id: S2, user_id: A, key: 'ai.enabled', value: false, deleted_at: null }],
    user_limits: [{ user_id: A, media_mb: 100 }],
    vault: [{ user_id: A, pin_hash: 'new-hash', pin_epoch: 5, fail_count: 4, lock_level: 2, locked_until: '2026-11-21T00:00:00Z' }],
    invites: [{ code_hash: 'h1', created_by: A, max_uses: 1, used_count: 1 }],
  };

  it('默认：vault、invites 不恢复；profiles 只覆盖非安全列；user_limits 不覆盖；settings 里 ai.* 一行不写（ai.vault 库里没有也不写）', async () => {
    const backup = loadBackup(reader(await makeBackup(data, A, REF, T)), A);
    const r = fakeDb(live, { cols });
    const dry = await restore({ backup, userId: A, target: REF, client: r.client, dryRun: true, only: null });
    expect(dry.skipped).toEqual(['vault', 'invites']);
    expect(dry.report.find((x: { table: string }) => x.table === 'settings')).toMatchObject({ backup: 3, insert: 1, overwrite: 0, kept: 2 });
    await restore({ backup, userId: A, target: REF, client: r.client, dryRun: false, only: null });
    expect(r.db.get('profiles')).toEqual([{ ...live.profiles[0], tz: 'Asia/Seoul' }]);
    expect(r.db.get('settings')).toEqual([live.settings[0], data.settings[0]]);
    expect(r.db.get('user_limits')).toEqual(live.user_limits);
    expect([r.db.get('vault'), r.db.get('invites')]).toEqual([live.vault, live.invites]);
  });

  it('--only vault：PIN 换回备份那个，pin_epoch 取两边较大的再加 1（旧令牌全失效），失败次数和锁定保留库里的；--only invites 已有的不覆盖', async () => {
    const backup = loadBackup(reader(await makeBackup(data, A, REF, T)), A);
    const r = fakeDb(live, { cols });
    await restore({ backup, userId: A, target: REF, client: r.client, dryRun: false, only: ['vault', 'invites'] });
    expect(r.db.get('vault')).toEqual([{ ...live.vault[0], pin_hash: 'old-hash', pin_epoch: 6 }]);
    expect(r.db.get('invites')).toEqual(live.invites);
    // 库里没有这一行：照备份插，pin_epoch 也加 1（备份时签的令牌不再认）
    const r2 = fakeDb({}, { cols });
    await restore({ backup, userId: A, target: REF, client: r2.client, dryRun: false, only: ['vault'] });
    expect(r2.db.get('vault')).toEqual([{ ...data.vault[0], pin_epoch: 4 }]);
  });
});

describe('B7a 复审第 9、10、11 条：报错分开、本机连接串、上限预算', () => {
  it('还没连上就出错报 db_connect（一条没写）；fn 做完、提交时出错报 commit_unknown（先 --dry-run 核对）；都不带原文', async () => {
    const backup = loadBackup(reader(await makeBackup(sample(), A)), A);
    const refused = { transaction: async () => { throw Object.assign(new Error('password authentication failed secret'), { code: '28P01' }); } };
    const e1 = await restore({ backup, userId: A, target: REF, client: refused, dryRun: false, only: ['notes'] }).catch((e: unknown) => e);
    expect(e1).toMatchObject({ code: 'db_connect' });
    expect(String((e1 as Error).message)).toContain('28P01');
    const r = fakeDb();
    const commitFails = { transaction: async (fn: (tx: unknown) => Promise<unknown>) => { await r.client.transaction(fn); throw Object.assign(new Error('Connection terminated secret'), { code: 'ECONNRESET' }); } };
    const e2 = await restore({ backup, userId: A, target: REF, client: commitFails, dryRun: false, only: ['notes'] }).catch((e: unknown) => e);
    expect(e2).toMatchObject({ code: 'commit_unknown' });
    expect(String((e2 as Error).message)).toContain('--dry-run');
    for (const e of [e1, e2]) expect(String((e as Error).message)).not.toContain('secret');
  });

  it('LEMO_RESTORE_DB_URL 只认本机；没设回空（改为提示粘贴）', () => {
    expect(dbUrlFromEnv(undefined)).toBe('');
    expect(dbUrlFromEnv('postgresql://postgres:postgres@127.0.0.1:55322/postgres')).toContain('127.0.0.1');
    expect(() => dbUrlFromEnv(`postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`)).toThrow(expect.objectContaining({ code: 'bad_args' }));
  });

  it('试运行算上限：一条待办恢复后看得见的子项超过 30 个、不豁免 row_quota 时库里加备份超过 2 万行，都写进 warnings；豁免时不报 row_quota', async () => {
    const TD: BackupTable[] = [{ name: 'todo_items', schema: 'public', lookupCol: 'user_id', keyCol: 'id', keyType: 'uuid', conflict: ['id'], maxRows: 25_000 }];
    const todo = id();
    const item = (deleted: number | null) => ({ id: id(), user_id: A, todo_id: todo, deleted_at: deleted, undone: false });
    const backup = loadBackup(reader(await makeBackup({ todo_items: Array.from({ length: 20 }, () => item(null)) }, A, REF, TD)), A);
    const initial = { todo_items: [...Array.from({ length: 11 }, () => item(null)), ...Array.from({ length: 5 }, () => item(9))] };
    const ok = await restore({ backup, userId: A, target: REF, client: fakeDb(initial).client, dryRun: true, only: null });
    expect(ok.warnings).toEqual(['todo_items：恢复后有 1 条待办看得见的子项超过 30 个（最多的一条 31 个，todo_items_cap），正式执行会报 items_quota 整体回退']);
    const big = { todo_items: Array.from({ length: 19_990 }, (_, i) => ({ id: `00000000-0000-4000-9000-${i.toString(16).padStart(12, '0')}`, user_id: A, todo_id: id(), deleted_at: null, undone: false })) };
    const w = await restore({ backup, userId: A, target: REF, client: fakeDb(big, { quota: { exempt: false, rowQuota: ['todo_items'] } }).client, dryRun: true, only: null });
    expect(w.warnings).toEqual(['todo_items：库里 19990 行加上备份新增的 20 行超过每人 20000 行（row_quota），正式执行会整体回退']);
    const ex = await restore({ backup, userId: A, target: REF, client: fakeDb(big, { quota: { exempt: true, rowQuota: ['todo_items'] } }).client, dryRun: true, only: null });
    expect(ex.warnings).toEqual([]);
  });
});

describe('restore-lib：对不上就整体拒绝、一条不写', () => {
  const sliceOf = (files: Map<string, Buffer>) => [...files.keys()].find((n) => /^[ab]_notes\.2\.json\.gz$/.test(n)) ?? '';

  it('文件被改过（sha256 对不上）、缺一片、没有 _manifest、user_id 不对', async () => {
    const files = await makeBackup(sample(), A);
    const sl = sliceOf(files);
    expect(sl).not.toBe('');
    const tampered = new Map(files);
    tampered.set(sl, Buffer.concat([files.get(sl) ?? Buffer.alloc(0), Buffer.from([0])]));
    expect(() => loadBackup(reader(tampered), A)).toThrow(expect.objectContaining({ code: 'checksum' }));
    const missing = new Map(files);
    missing.delete(sl);
    expect(() => loadBackup(reader(missing), A)).toThrow(expect.objectContaining({ code: 'missing_file' }));
    const noMan = new Map(files);
    noMan.delete('_manifest.json.gz');
    expect(() => loadBackup(reader(noMan), A)).toThrow(expect.objectContaining({ code: 'no_manifest' }));
    expect(() => loadBackup(reader(files), B)).toThrow(expect.objectContaining({ code: 'wrong_user' }));
  });

  it('文件里混进别人的行、行数和 _manifest 不一致（重新算过 sha256 也不行）；清单指向另一代的文件也不行', async () => {
    const files = await makeBackup(sample(), A);
    const gen = manifestOf(files).gen;
    const rewrite = (rows: Row[], name = `${gen}_profiles.json.gz`) => {
      const gz = gzipSync(Buffer.from(JSON.stringify({ format: 'lemomemo-backup', version: 1, table: 'profiles', rows })));
      const m = new Map(files);
      m.set(name, gz);
      const man = manifestOf(files);
      const t = man.tables.find((x: { name: string }) => x.name === 'profiles');
      t.files[0].name = name;
      t.files[0].bytes = gz.byteLength;
      t.files[0].sha256 = createHash('sha256').update(gz).digest('hex');
      m.set('_manifest.json.gz', gzipSync(Buffer.from(JSON.stringify(man))));
      return m;
    };
    expect(() => loadBackup(reader(rewrite([{ user_id: B }])), A)).toThrow(expect.objectContaining({ code: 'foreign_row' }));
    expect(() => loadBackup(reader(rewrite([])), A)).toThrow(expect.objectContaining({ code: 'row_count' }));
    const other = gen === 'a' ? 'b' : 'a';
    expect(() => loadBackup(reader(rewrite([{ user_id: A }], `${other}_profiles.json.gz`)), A)).toThrow(expect.objectContaining({ code: 'bad_manifest' }));
  });

  it('备份出自别的项目：不往这个项目写（0.29 续第 95 条②）；本机不限', async () => {
    const backup = loadBackup(reader(await makeBackup(sample(), A, 'zzzzzzzzzzzzzzzzzzzz')), A);
    const r = fakeDb();
    await expect(restore({ backup, userId: A, target: REF, client: r.client, dryRun: true, only: null })).rejects.toMatchObject({ code: 'wrong_project' });
    expect(r.txCount).toBe(0);
    expect((await restore({ backup, userId: A, target: 'local', client: r.client, dryRun: true, only: null })).report).toHaveLength(3);
  });

  it('写库失败：整个事务回退（前面写过的表也不留），报 db_write，不带库的原始报错', async () => {
    const backup = loadBackup(reader(await makeBackup(sample(), A)), A);
    const r = fakeDb({}, { failOn: 'vault_ai' });
    const err = await restore({ backup, userId: A, target: REF, client: r.client, dryRun: false, only: null }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'db_write' });
    expect(String((err as Error).message)).not.toContain('secret row text');
    expect(String((err as Error).message)).toContain('23505');
    expect(r.writes.map((w) => w.table)).toContain('notes');   // notes 已写过……
    expect(r.db.size).toBe(0);                                  // ……但事务回退，库里一条没留
  });
});

describe('restore-lib：sqlClient 拼的语句', () => {
  type Tx = { keys: (...a: unknown[]) => Promise<unknown>; columns: (...a: unknown[]) => Promise<unknown>; upsert: (...a: unknown[]) => Promise<unknown> };
  it('值都走参数；表名、列名加双引号；按 jsonb_populate_recordset 写，冲突键是主键；只有主键列时 do nothing', async () => {
    const calls: [string, unknown[]][] = [];
    const tx = { unsafe: async (q: string, params: unknown[]) => { calls.push([q, params]); return q.startsWith('select a.attname') ? [{ name: 'id', ident: '' }] : []; } };
    const client = sqlClient({ begin: async (fn: (t: unknown) => Promise<unknown>) => await fn(tx) });
    await client.transaction(async (t: Tx) => {
      await t.keys({ name: 'notes', schema: 'public', key: ['id'], lookup: 'user_id' }, A);
      await t.columns({ name: 'notes', schema: 'public' });
      await t.upsert({ name: 'notes', schema: 'public', key: ['id'] }, ['id', 'user_id', 'body'], false, [{ id: 'x', user_id: A, body: "'; drop table x; --" }]);
      await t.upsert({ name: 'vault_ai', schema: 'private', key: ['kind', 'source_id'] }, ['kind', 'source_id'], false, [{ kind: 'image', source_id: 'y' }]);
    });
    expect(calls[0]).toEqual(['select "id"::text as "id" from "public"."notes" where "user_id" = $1::uuid', [A]]);
    expect(calls[1]?.[1]).toEqual(['public.notes']);
    expect(calls[2]?.[0]).toContain('insert into "public"."notes" as t ("id", "user_id", "body")');
    expect(calls[2]?.[0]).toContain('select r."id", r."user_id", r."body" from');
    // 参数按 text 传再转 jsonb（$1::jsonb 时 postgres.js 会把字符串再编码一次，库收到的不是数组；本机真库实测 22023）
    expect(calls[2]?.[0]).toContain('from jsonb_populate_recordset(null::"public"."notes", $1::text::jsonb) as r');
    expect(typeof calls[2]?.[1]?.[0]).toBe('string');
    expect(calls[2]?.[0]).toContain('on conflict ("id") do update set "user_id" = excluded."user_id", "body" = excluded."body"');
    expect(calls[2]?.[0]).not.toContain('drop table');
    expect(calls[3]?.[0]).toContain('on conflict ("kind", "source_id") do nothing');
    // 主键以外的唯一索引（SECOND_UNIQUE）：只动这个人（$1）的行；备份行、id 列表、改指表、设置 key 都走参数，不拼进语句
    const bad = "'; drop table x; --";
    const tb = (name: string, schema: string, rows: Row[]) => ({ name, schema, key: ['id'], lookup: 'user_id', rows });
    const mem = tb('ai_memories', 'private', [{ id: 'y', user_id: A, norm: bad, deleted_at: null }, { id: 'z', user_id: A, norm: 'gone', deleted_at: 7 }]);
    const cat = tb('categories', 'public', [{ id: 'c', user_id: A, vault: false, name: bad, color: 'x', deleted_at: null }]);
    const set = tb('settings', 'public', [{ id: 's', user_id: A, key: 'ui.theme', value: bad, deleted_at: 5 }]);
    // partial 的只比没删的行；settings 不分删没删；只留 id 和唯一值列，都转成字符串
    expect(uniqueRowsOf(mem, SECOND_UNIQUE.ai_memories)).toEqual([{ id: 'y', norm: bad }]);
    expect(uniqueRowsOf(cat, SECOND_UNIQUE.categories)).toEqual([{ id: 'c', vault: 'false', name: bad }]);
    expect(uniqueRowsOf(set, SECOND_UNIQUE.settings)).toEqual([{ id: 's', key: 'ui.theme' }]);
    expect(() => uniqueRowsOf({ ...cat, key: ['id', 'user_id'] }, SECOND_UNIQUE.categories)).toThrow(RestoreError);
    const map = [{ old: 'o', new: 'n' }];
    type Tx2 = Tx & Record<'conflicts' | 'resolve' | 'refCount' | 'repoint', (...a: unknown[]) => Promise<unknown>>;
    await client.transaction(async (t: Tx2) => {
      await t.conflicts(mem, SECOND_UNIQUE.ai_memories, A, uniqueRowsOf(mem, SECOND_UNIQUE.ai_memories));   // 4
      await t.resolve(mem, SECOND_UNIQUE.ai_memories, A, ['o']);                                            // 5
      await t.conflicts(cat, SECOND_UNIQUE.categories, A, uniqueRowsOf(cat, SECOND_UNIQUE.categories));     // 6
      await t.resolve(set, SECOND_UNIQUE.settings, A, ['o']);                                               // 7
      for (const ref of SECOND_UNIQUE.categories.refs) { await t.refCount(ref, A, map); await t.repoint(ref, A, map); }   // 8–13
    });
    expect(calls[4]?.[0]).toContain(`from "private"."ai_memories" as m join jsonb_array_elements($2::text::jsonb) x on m."norm"::text = (x->>'norm')`);
    expect(calls[4]?.[0]).toContain(`where m."user_id" = $1::uuid and m."deleted_at" is null and m."id"::text <> x->>'id'`);
    expect(calls[4]?.[1]).toEqual([A, JSON.stringify([{ id: 'y', norm: bad }])]);
    expect(calls[5]?.[0]).toContain('update "private"."ai_memories" set "deleted_at" = (extract(epoch from clock_timestamp()) * 1000)::bigint where "user_id" = $1::uuid');
    expect(calls[5]?.[0]).toContain('and "deleted_at" is null returning 1');
    expect(calls[6]?.[0]).toContain(`on m."vault"::text = (x->>'vault') and lower(m."name"::text) = lower((x->>'name'))`);
    expect(calls[6]?.[0]).toContain('m."deleted_at" is null');
    expect(calls[7]?.[0]).toMatch(/^delete from "public"."settings" where "user_id" = \$1::uuid and "id"::text in \(select jsonb_array_elements_text\(\$2::text::jsonb\)\) returning 1$/);
    for (const c of [calls[5], calls[7]]) expect(c?.[1]).toEqual([A, '["o"]']);
    expect(calls[8]?.[0]).toContain('from "public"."notes" r where r."user_id" = $1::uuid');
    expect(calls[8]?.[0]).toContain('and r."category_id" in (select old::uuid from jsonb_to_recordset($2::text::jsonb)');
    expect(calls[9]?.[0]).toContain('update "public"."notes" r set "category_id" = mp.new::uuid from jsonb_to_recordset($2::text::jsonb) as mp(old text, new text)');
    expect(calls[11]?.[0]).toContain('update "public"."categories" r set "merged_into" = mp.new::uuid');
    expect(calls[13]?.[0]).toContain('update "public"."settings" s set "value" =');
    for (const c of calls.slice(8, 14)) expect(c[1].slice(0, 2)).toEqual([A, JSON.stringify(map)]);
    for (const c of [calls[12], calls[13]]) expect(c?.[1]?.[2]).toBe(JSON.stringify(['notes.merge_suggest', 'notes.merge_dismissed']));
    for (const c of calls.slice(4)) expect(c[0]).not.toContain('drop table');
    expect(calls).toHaveLength(14);
    await expect(client.transaction(async (t: Tx) => t.keys({ name: 'Bad"', schema: 'public', key: ['id'], lookup: 'user_id' }, A))).rejects.toThrow(RestoreError);
  });
});
