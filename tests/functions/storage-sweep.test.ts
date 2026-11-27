// storage-sweep 的单元测试（架构 3.4“30 天清理分两段做”“孤儿清理”、第 6 节；接手清单 P-b4-sweep-gate）。
// 只测 core.ts（index.ts 只是把 supabase-js 和 R2 接上），数据库和 R2 由假对象代替。
import { describe, expect, it, vi } from 'vitest';
import {
  DOC_KINDS,
  HEARTBEAT,
  KEEP_MS,
  ORPHAN_AFTER_MS,
  SWEEP_BUCKETS,
  handle,
  parseKey,
  rotate,
  sweepStart,
  type AnnivRow,
  type Deps,
  type FileRow,
  type HeartbeatDetail,
  type ImageRow,
  type ProfileRow,
  type SweepBackups,
  type SweepR2,
  type SweepStore,
  BACKUP_DELETE_BATCH,
  expiredBackupDates,
} from '../../supabase/functions/storage-sweep/core.ts';
import { BACKUP_KEEP_DAYS, backupDate } from '../../supabase/functions/_shared/backup-format.ts';
import { R2_BUCKETS } from '../../supabase/functions/usage-report/usage.ts';
import { allManifests } from '../../shared/manifests/index.ts';
import { DOC_TYPES } from '../../shared/manifests/attachments.ts';

const SECRET = 'test-cron-secret-xxxxxxxxxxxxxxxxxxxxx';
const NOW = Date.parse('2026-11-26T17:30:00Z');
const DAY = 86_400_000;
const u = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const A = u(1);   // 用户 A
const B = u(2);   // 用户 B
const N1 = u(11);
const OLD = NOW - 2 * DAY;      // 对象建于两天前（超过 24 小时）
const FRESH = NOW - 3_600_000;  // 一小时前

type Obj = { key: string; size: number; lastModified?: number };

interface World {
  objects: Partial<Record<string, Obj[]>>;
  images?: ImageRow[];
  files?: FileRow[];
  annivs?: AnnivRow[];
  profiles?: ProfileRow[];
  /** backups 桶里的文件路径 */
  backups?: string[];
}

function setup(w: World, over: Partial<Deps> = {}, r2Over: Partial<SweepR2> = {}, backupsOver: Partial<SweepBackups> = {}) {
  const deleted: [string, string[]][] = [];
  const beats: HeartbeatDetail[] = [];
  const pick = <T extends { id?: string; user_id?: string }>(rows: T[] | undefined, ids: readonly string[], by: 'id' | 'user_id') =>
    (rows ?? []).filter((r) => ids.includes(String(r[by])));
  const store: SweepStore = {
    images: async (ids) => pick(w.images, ids, 'id'),
    files: async (ids) => pick(w.files, ids, 'id'),
    annivs: async (ids) => pick(w.annivs, ids, 'id'),
    profiles: async (ids) => pick(w.profiles, ids, 'user_id'),
    writeHeartbeat: async (d) => void beats.push(d),
  };
  const r2: SweepR2 = {
    // 每页 2 个：顺带测翻页
    list: async (bucket, _p, opts) => {
      const all = w.objects[bucket] ?? [];
      const start = opts?.continuationToken ? Number(opts.continuationToken) : 0;
      const end = start + 2;
      return { objects: all.slice(start, end), nextToken: end < all.length ? String(end) : null };
    },
    deleteMany: async (bucket, keys) => {
      deleted.push([bucket, [...keys]]);
      return keys.length;
    },
    ...r2Over,
  };
  // 和 Storage 的 list 一样只列一层：路径里还有一段的算子目录；只有列、删两样，没有写（account-purge 的游标前提：没人往旧日期里写）
  const bk = new Set(w.backups ?? []);
  const batches: string[][] = [];
  const backups: SweepBackups = {
    list: async (dir) => {
      const pre = dir === '' ? '' : `${dir}/`;
      const out = new Map<string, boolean>();
      for (const p of bk) {
        if (!p.startsWith(pre)) continue;
        const rest = p.slice(pre.length);
        const i = rest.indexOf('/');
        out.set(i < 0 ? rest : rest.slice(0, i), i >= 0);
      }
      return [...out].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, folder]) => ({ name, folder }));
    },
    remove: async (paths) => { batches.push([...paths]); for (const p of paths) bk.delete(p); },
    ...backupsOver,
  };
  const log = vi.fn();
  const deps: Deps = { cronSecret: SECRET, store, r2, backups, now: () => NOW, log, ...over };
  return { deps, deleted, beats, log, bk, batches };
}

function req(body: unknown = {}, secret: string | null = SECRET, method = 'POST'): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (secret !== null) headers.set('x-cron-secret', secret);
  return new Request('https://x.supabase.co/functions/v1/storage-sweep', method === 'GET' ? { method, headers } : { method, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

const img = (id: string, over: Partial<ImageRow> = {}): ImageRow => ({ id, user_id: A, note_id: N1, bucket: 'images', has_thumb: false, deleted_at: null, ...over });
const file = (id: string, over: Partial<FileRow> = {}): FileRow => ({ id, user_id: A, note_id: N1, kind: 'pdf', has_thumb: false, is_vault: false, check_status: 'ok', deleted_at: null, ...over });
const keysOf = (d: [string, string[]][]) => d.flatMap(([b, ks]) => ks.map((k) => `${b}:${k}`)).sort();

describe('storage-sweep 鉴权和请求', () => {
  it('只收 POST；没带或带错 x-cron-secret 回 401，不列 R2', async () => {
    const list = vi.fn();
    const { deps } = setup({ objects: {} }, {}, { list });
    expect((await handle(req({}, SECRET, 'GET'), deps)).status).toBe(405);
    for (const s of [null, '', 'wrong']) expect((await handle(req({}, s), deps)).status).toBe(401);
    expect(list).not.toHaveBeenCalled();
  });

  it('鉴权过了才判配置：缺数据库、R2 或 backups 桶回 500 misconfigured', async () => {
    const a = setup({ objects: {} }, { store: null });
    expect((await handle(req({}, 'wrong'), a.deps)).status).toBe(401);
    expect((await handle(req(), a.deps)).status).toBe(500);
    expect(a.log.mock.calls).toEqual([['misconfigured']]);
    expect((await handle(req(), setup({ objects: {} }, { r2: null }).deps)).status).toBe(500);
    expect((await handle(req(), setup({ objects: {} }, { backups: null }).deps)).status).toBe(500);
  });

  it('请求体：空体、{} 可以；不是对象、dry_run 不是布尔回 400', async () => {
    const { deps } = setup({ objects: {} });
    expect((await handle(req(''), deps)).status).toBe(200);
    expect((await handle(req({}), deps)).status).toBe(200);
    for (const b of ['[]', 'null', '{bad', JSON.stringify({ dry_run: 'yes' })]) expect((await handle(req(b), deps)).status).toBe(400);
  });
});

describe('storage-sweep 判定', () => {
  const I1 = u(101);
  const I2 = u(102);
  const I3 = u(103);
  const I4 = u(104);

  it('行在、没删 → 留；删了不到 30 天 → 留；删了超过 30 天 → 删；行没了且超过 24 小时 → 删；不到 24 小时、没有时刻 → 留', async () => {
    const w: World = {
      objects: {
        images: [
          { key: `${A}/${N1}/${I1}.webp`, size: 1, lastModified: OLD },
          { key: `${A}/${N1}/${I2}.webp`, size: 1, lastModified: OLD },
          { key: `${A}/${N1}/${I3}.webp`, size: 1, lastModified: OLD },
          { key: `${A}/${N1}/${I4}.webp`, size: 1, lastModified: OLD },          // 没有行，两天前 → 孤儿
          { key: `${A}/${N1}/${u(105)}.webp`, size: 1, lastModified: FRESH },    // 没有行，一小时前 → 留
          { key: `${A}/${N1}/${u(106)}.webp`, size: 1 },                         // 没有行，没有时刻 → 留
        ],
      },
      images: [img(I1), img(I2, { deleted_at: NOW - KEEP_MS + DAY }), img(I3, { deleted_at: String(NOW - KEEP_MS - 1) })],
    };
    const { deps, deleted, beats } = setup(w);
    const r = await handle(req(), deps);
    expect(r.status).toBe(200);
    expect(keysOf(deleted)).toEqual([`images:${A}/${N1}/${I3}.webp`, `images:${A}/${N1}/${I4}.webp`].sort());
    expect(beats).toHaveLength(1);
    expect(beats[0]).toMatchObject({ listed: 6, kept: 2, expired: 1, orphans: 1, young: 2, unknown: 0, deleted: 2, failed: 0, budget_hit: false, cap_hit: false });
  });

  it('H7：路径第一段的 user_id 和行对不上（别人的行）不算对得上；note_id、桶对不上也一样', async () => {
    const w: World = {
      objects: {
        images: [{ key: `${B}/${N1}/${I1}.webp`, size: 1, lastModified: OLD }, { key: `${A}/${u(12)}/${I2}.webp`, size: 1, lastModified: OLD }],
        'vault-images': [{ key: `${A}/${N1}/${I3}.webp`, size: 1, lastModified: OLD }],
      },
      images: [img(I1), img(I2), img(I3)],   // I3 的行 bucket = images，对象却在 vault-images
    };
    const { deps, deleted } = setup(w);
    await handle(req(), deps);
    expect(keysOf(deleted)).toEqual([`images:${B}/${N1}/${I1}.webp`, `images:${A}/${u(12)}/${I2}.webp`, `vault-images:${A}/${N1}/${I3}.webp`].sort());
  });

  it('缩略图：行的 has_thumb 为假时 .t.webp 是孤儿；为真时留', async () => {
    const w: World = {
      objects: { images: [{ key: `${A}/${N1}/${I1}.t.webp`, size: 1, lastModified: OLD }, { key: `${A}/${N1}/${I2}.t.webp`, size: 1, lastModified: OLD }] },
      images: [img(I1, { has_thumb: true }), img(I2)],
    };
    const { deps, deleted } = setup(w);
    await handle(req(), deps);
    expect(keysOf(deleted)).toEqual([`images:${A}/${N1}/${I2}.t.webp`]);
  });

  it('附件：扩展名要等于 kind；is_vault 要和桶对上；rejected 算孤儿；缩略图看 has_thumb', async () => {
    const F = [u(201), u(202), u(203), u(204), u(205)];
    const w: World = {
      objects: {
        files: [
          { key: `${A}/${N1}/${F[0]}.pdf`, size: 1, lastModified: OLD },    // 留
          { key: `${A}/${N1}/${F[1]}.docx`, size: 1, lastModified: OLD },   // kind 是 pdf → 孤儿
          { key: `${A}/${N1}/${F[2]}.pdf`, size: 1, lastModified: OLD },    // 行在隐私记 → 孤儿
          { key: `${A}/${N1}/${F[3]}.pdf`, size: 1, lastModified: OLD },    // rejected → 孤儿
          { key: `${A}/${N1}/${F[4]}.t.webp`, size: 1, lastModified: OLD }, // has_thumb → 留
        ],
        'vault-files': [{ key: `${A}/${N1}/${F[2]}.pdf`, size: 1, lastModified: OLD }],   // 留
      },
      files: [file(F[0]!), file(F[1]!), file(F[2]!, { is_vault: true }), file(F[3]!, { check_status: 'rejected' }), file(F[4]!, { has_thumb: true })],
    };
    const { deps, deleted } = setup(w);
    await handle(req(), deps);
    expect(keysOf(deleted)).toEqual([`files:${A}/${N1}/${F[1]}.docx`, `files:${A}/${N1}/${F[2]}.pdf`, `files:${A}/${N1}/${F[3]}.pdf`].sort());
  });

  it('头像：纪念日头像要等于当前 avatar_id（换掉的是孤儿）；我的头像看 profiles.avatar_id', async () => {
    const AN = u(301);
    const AV1 = u(311);
    const AV2 = u(312);
    const ME1 = u(321);
    const ME2 = u(322);
    const w: World = {
      objects: {
        images: [
          { key: `${A}/anniv/${AN}/${AV1}.webp`, size: 1, lastModified: OLD },
          { key: `${A}/anniv/${AN}/${AV2}.webp`, size: 1, lastModified: OLD },
          { key: `${A}/me/${ME1}.webp`, size: 1, lastModified: OLD },
          { key: `${A}/me/${ME2}.webp`, size: 1, lastModified: OLD },
        ],
      },
      annivs: [{ id: AN, user_id: A, avatar_id: AV1, deleted_at: null }],
      profiles: [{ user_id: A, avatar_id: ME1 }],
    };
    const { deps, deleted } = setup(w);
    await handle(req(), deps);
    expect(keysOf(deleted)).toEqual([`images:${A}/anniv/${AN}/${AV2}.webp`, `images:${A}/me/${ME2}.webp`].sort());
  });

  it('拆不出来的键（不是清单里的路径）不删，只计 unknown；头像路径只认 images 桶', async () => {
    const w: World = {
      objects: {
        images: [{ key: 'readme.txt', size: 1, lastModified: OLD }, { key: `${A}/${N1}/x.webp`, size: 1, lastModified: OLD }],
        'vault-images': [{ key: `${A}/me/${u(9)}.webp`, size: 1, lastModified: OLD }],
      },
    };
    const { deps, deleted, beats } = setup(w);
    await handle(req(), deps);
    expect(deleted).toEqual([]);
    expect(beats[0]).toMatchObject({ unknown: 3, deleted: 0 });
  });
});

describe('storage-sweep 护栏', () => {
  const many = (n: number): Obj[] => Array.from({ length: n }, (_, i) => ({ key: `${A}/${N1}/${u(1000 + i)}.webp`, size: 1, lastModified: OLD }));

  it('dry_run：只数不删、不写心跳，回 200 带个数', async () => {
    const { deps, deleted, beats } = setup({ objects: { images: many(3) } });
    const r = await handle(req({ dry_run: true }), deps);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, dry_run: true, orphans: 3, deleted: 0 });
    expect(deleted).toEqual([]);
    expect(beats).toEqual([]);
  });

  it('一轮最多删 maxDeletes 个，到了 cap_hit、其余只列不删', async () => {
    const { deps, deleted, beats } = setup({ objects: { images: many(5) } }, { maxDeletes: 3 });
    await handle(req(), deps);
    expect(keysOf(deleted)).toHaveLength(3);
    expect(beats[0]).toMatchObject({ listed: 5, orphans: 5, deleted: 3, cap_hit: true });
  });

  it('超时间预算：停在当前位置，budget_hit、记 time_budget，照常写心跳', async () => {
    let t = NOW;
    const { deps, beats, log } = setup({ objects: { images: many(6) } }, { now: () => (t += 40_000), budgetMs: 100_000 });
    const r = await handle(req(), deps);
    expect(r.status).toBe(200);
    expect(beats[0]?.budget_hit).toBe(true);
    expect(beats[0]?.listed).toBeLessThan(6);
    expect(log.mock.calls).toContainEqual(['time_budget']);
  });

  it('B7a 评审第 10 条：每天从不同的桶开始，四天轮一圈；时间预算不够时被跳过的桶隔天先做；detail 记 start、buckets_done', async () => {
    expect([0, 1, 2, 3, 4].map((d) => sweepStart(NOW + d * DAY))).toEqual([0, 1, 2, 3, 0].map((i) => (sweepStart(NOW) + i) % 4));
    expect(rotate(2)).toEqual([SWEEP_BUCKETS[2], SWEEP_BUCKETS[3], SWEEP_BUCKETS[0], SWEEP_BUCKETS[1]]);
    const order: string[] = [];
    const objects = Object.fromEntries(SWEEP_BUCKETS.map((b) => [b, [] as Obj[]]));
    const { deps, beats } = setup({ objects }, {}, {
      list: async (bucket) => { order.push(bucket); return { objects: [], nextToken: null }; },
    });
    await handle(req(), deps);
    expect(order).toEqual(rotate(sweepStart(NOW)));
    expect(beats[0]).toMatchObject({ start: sweepStart(NOW), buckets_done: 4, budget_hit: false });
    // 第一个桶就超预算：buckets_done 为 0，第二天从下一个桶开始
    let t = NOW;
    const b = setup({ objects: { [rotate(sweepStart(NOW))[0] ?? 'images']: many(6) } }, { now: () => (t += 40_000), budgetMs: 100_000 });
    await handle(req(), b.deps);
    expect(b.beats[0]).toMatchObject({ budget_hit: true, buckets_done: 0 });
  });

  it('删失败：计 failed、记 delete_failed:<桶>，回 503 try_later，不写心跳（lemo-ops 26 小时后告警）', async () => {
    const { deps, beats, log } = setup({ objects: { files: [{ key: `${A}/${N1}/${u(5)}.pdf`, size: 1, lastModified: OLD }] } }, {}, {
      deleteMany: async () => { throw new Error('delete_partial'); },
    });
    const r = await handle(req(), deps);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: 'try_later', failed: 1 });
    expect(beats).toEqual([]);
    expect(log.mock.calls).toEqual([['delete_failed:files']]);
  });

  it('列对象或读库出错：整轮 503，记 sweep_failed，不删、不写心跳；日志不带原始错误', async () => {
    const a = setup({ objects: {} }, {}, { list: async () => { throw new Error('https://secret@r2'); } });
    expect((await handle(req(), a.deps)).status).toBe(503);
    expect(a.log.mock.calls).toEqual([['sweep_failed']]);
    expect(a.beats).toEqual([]);
    const b = setup({ objects: { images: many(1) } });
    b.deps.store!.images = async () => { throw new Error('db'); };
    expect((await handle(req(), b.deps)).status).toBe(503);
    expect(b.deleted).toEqual([]);
  });

  it('写心跳失败回 503（删已经做了，下一轮再写）', async () => {
    const { deps, log } = setup({ objects: {} });
    deps.store!.writeHeartbeat = async () => { throw new Error('db'); };
    expect((await handle(req(), deps)).status).toBe(503);
    expect(log.mock.calls).toEqual([['heartbeat_failed']]);
  });
});

describe('storage-sweep 服务器备份保留 7 天（B7a 收口第 2 条，架构 15.7 第 7 项）', () => {
  // NOW 是首尔 2026-11-27 02:30：留当天和前 6 天（11-21～11-27），11-20 及更早的删
  const day = (n: number) => backupDate(NOW - n * DAY);
  const C = u(3);   // 停用账号：storage-sweep 不看账号状态，照删
  const files = (d: string, who: string) => [`${d}/${who}/_manifest.json.gz`, `${d}/${who}/a_notes.json.gz`];
  /** 最近 7 天各一份（桶里最新的 7 个日期永远留着，不垫上这些，旧日期就是最新的、不会删） */
  const recent = [0, 1, 2, 3, 4, 5, 6].map((n) => `${day(n)}/${A}/_manifest.json.gz`);

  it('所有人（含停用的）早于当天往前 6 天的日期目录全删；第 6 天那天、不是日期的目录、不是 uuid 的目录、散放的文件、用户目录里的子目录都不动', async () => {
    expect([day(0), day(6), day(7)]).toEqual(['2026-11-27', '2026-11-21', '2026-11-20']);
    const keep = [
      ...[0, 1, 2, 3, 4, 5, 6].flatMap((n) => [...files(day(n), A), ...files(day(n), B)]),
      `junk/${A}/a_notes.json.gz`, 'readme.txt', `${day(8)}/not-a-uuid/a_notes.json.gz`, `${day(8)}/${B}/sub/a_notes.json.gz`, `${day(8)}/${B}/a_notes.json.gz`,
    ];
    const gone = [...files(day(7), A), ...files(day(7), C), ...files(day(30), C)];
    const { deps, bk, beats } = setup({ objects: {}, backups: [...keep, ...gone] });
    expect((await handle(req(), deps)).status).toBe(200);
    expect([...bk].sort()).toEqual([...keep].sort());
    // 根下散放的 readme.txt、不是 uuid 的目录、有子目录的 B 各算一个 unknown（不是日期的 junk 目录不列、不计）
    expect(beats[0]).toMatchObject({ backup_dates: 3, backup_files: 6, deleted: 6, failed: 0, unknown: 3, backup_budget_hit: false, backup_cap_hit: false });
  });

  it('时钟出错也删不到最近的备份：桶里最新的 7 个日期永远留着', () => {
    const dates = [10, 11, 12, 13, 14, 15, 16, 17, 18].map(day);   // 全都早于保留期
    expect(expiredBackupDates(dates, NOW)).toEqual([day(18), day(17)]);
    expect(expiredBackupDates(dates.slice(2), NOW)).toEqual([]);
    expect(expiredBackupDates(['2026-1-01', 'junk', day(20)], NOW)).toEqual([]);   // 只有一个合格日期，又是最新的 7 个之一
    expect(BACKUP_KEEP_DAYS).toBe(7);
  });

  it(`一次最多删 ${BACKUP_DELETE_BATCH} 个；dry_run 只数不删`, async () => {
    const many = [A, B, C].flatMap((who) => Array.from({ length: 400 }, (_, i) => `${day(9)}/${who}/a_t${i}.json.gz`));
    const a = setup({ objects: {}, backups: [...recent, ...many] });
    await handle(req(), a.deps);
    expect(a.batches.map((x) => x.length)).toEqual([1000, 200]);
    expect([...a.bk].sort()).toEqual([...recent].sort());
    const b = setup({ objects: {}, backups: [...recent, ...many] });
    expect(await (await handle(req({ dry_run: true }), b.deps)).json()).toMatchObject({ backup_files: 1200, deleted: 0 });
    expect([b.batches, b.bk.size]).toEqual([[], 1207]);
  });

  it('到了个数上限 backup_cap_hit、到了时间 backup_budget_hit：余下的明天接着删，R2 四个桶照做，心跳照写', async () => {
    const many = [...recent, ...[A, B, C].flatMap((who) => files(day(9), who))];
    const a = setup({ objects: {}, backups: many }, { backupMaxDeletes: 3 });
    expect((await handle(req(), a.deps)).status).toBe(200);
    expect([a.bk.size, a.beats[0]?.backup_cap_hit, a.beats[0]?.cap_hit, a.beats[0]?.buckets_done]).toEqual([7 + 3, true, false, 4]);
    let t = NOW;
    const b = setup({ objects: {}, backups: many }, { now: () => (t += 10), backupBudgetMs: 1 });
    expect((await handle(req(), b.deps)).status).toBe(200);
    expect([b.bk.size, b.beats[0]?.backup_budget_hit, b.beats[0]?.budget_hit, b.beats[0]?.buckets_done]).toEqual([7 + 6, true, false, 4]);
    expect(b.log.mock.calls).toEqual([['time_budget:backups']]);
  });

  it('删失败计 failed、记 delete_failed:backups，回 503 不写心跳；列目录出错整轮 503 sweep_failed', async () => {
    const a = setup({ objects: {}, backups: [...recent, ...files(day(9), A)] }, {}, {}, { remove: async () => { throw new Error('storage'); } });
    const r = await handle(req(), a.deps);
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ error: 'try_later', failed: 2 });
    expect([a.beats, a.log.mock.calls]).toEqual([[], [['delete_failed:backups']]]);
    const b = setup({ objects: {} }, {}, {}, { list: async () => { throw new Error('storage'); } });
    expect((await handle(req(), b.deps)).status).toBe(503);
    expect(b.log.mock.calls).toEqual([['sweep_failed']]);
  });
});

describe('storage-sweep 和清单一致', () => {
  const r2Swept = allManifests.flatMap((m) => m.buckets).filter((b) => b.store === 'r2' && b.orphanSweep !== null);

  it('四个桶 = 清单里 orphanSweep 不为空的 r2 桶 = usage-report 数字节的桶；孤儿时限都是 24 小时', () => {
    expect([...new Set(r2Swept.map((b) => b.name))].sort()).toEqual([...SWEEP_BUCKETS].sort());
    expect([...R2_BUCKETS].sort()).toEqual([...SWEEP_BUCKETS].sort());
    expect(new Set(r2Swept.map((b) => b.orphanSweep?.after))).toEqual(new Set(['24 hours']));
    expect(ORPHAN_AFTER_MS).toBe(24 * 3_600_000);
    expect(HEARTBEAT).toBe('storage-sweep');
  });

  it('附件扩展名和清单 DOC_TYPES 一致', () => {
    expect([...DOC_KINDS].sort()).toEqual(Object.keys(DOC_TYPES).sort());
  });

  it('每种能拆的路径都合清单里同一个桶的某条 pathPattern', () => {
    const samples: [string, string][] = [
      ['images', `${A}/${N1}/${u(1)}.webp`], ['images', `${A}/${N1}/${u(1)}.t.webp`],
      ['images', `${A}/anniv/${u(2)}/${u(3)}.webp`], ['images', `${A}/me/${u(4)}.webp`],
      ['vault-images', `${A}/${N1}/${u(1)}.webp`],
      ['files', `${A}/${N1}/${u(1)}.pdf`], ['files', `${A}/${N1}/${u(1)}.t.webp`], ['vault-files', `${A}/${N1}/${u(1)}.xlsx`],
    ];
    for (const [bucket, key] of samples) {
      expect(parseKey(bucket as (typeof SWEEP_BUCKETS)[number], key), key).not.toBeNull();
      expect(r2Swept.some((b) => b.name === bucket && new RegExp(b.pathPattern).test(key)), `${bucket}:${key}`).toBe(true);
    }
  });
});
