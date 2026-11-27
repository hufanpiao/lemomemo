// account-purge 删 backups 的“删到哪个日期”游标（接手清单 PURGE-date-cursor，迁移 20261105130000，11-05 后端）：
// ① 纯函数 backupDatesToScan、advanceBackupCursor 的规则；② 整轮跑：几百个日期的账号不再几十轮才删完，空日期不再每轮重列；
// ③ 停下的原因不同（预算、删完不为 0）都把游标写回，只往后推，不记最后一个日期，最后一个日期每轮照列。
// 真库那一半（列的 check、requested_at 变了清空游标、只往后推的写法）在 supabase/tests/rls/39_purge_backups_cursor.test.sql。
import { describe, expect, it } from 'vitest';
import { advanceBackupCursor, BACKUP_DAY, BACKUP_RECENT_KEEP, backupDatesToScan } from '../../supabase/functions/account-purge/core.ts';
import { A, B, type FakeBackups } from './account-fakes.ts';
import { requestDeletion, runPurge, toFirstRun, world } from './account-purge-harness.ts';

const MIN = 60_000;
const day = (i: number) => `2026${String(1001 + i).padStart(4, '0')}`;

function seedDates(backups: FakeBackups, n: number) {
  for (let i = 0; i < n; i++) {
    backups.files.add(`${day(i)}/${A}/notes.json.gz`);
    backups.files.add(`${day(i)}/${B}/notes.json.gz`);
  }
}

describe('backupDatesToScan：这一轮列哪些日期', () => {
  it('没有游标：全列、升序', () => {
    expect(backupDatesToScan(['20261003', '20261001', '20261002'], null)).toEqual(['20261001', '20261002', '20261003']);
  });
  const d12 = Array.from({ length: 12 }, (_, i) => `202610${String(i + 1).padStart(2, '0')}`);   // 20261001～20261012
  it('跳过不大于游标的同一种写法；最新的 8 个、最后一个永远照列', () => {
    expect(BACKUP_RECENT_KEEP).toBe(8);
    expect(backupDatesToScan(d12, '20261003')).toEqual(d12.slice(3));
    expect(backupDatesToScan(d12, '20261010')).toEqual(d12.slice(4));   // 游标推进了最新 8 个里面：这 8 个照列
    expect(backupDatesToScan(d12.map((d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}`), '2026-10-02').length).toBe(10);
    expect(backupDatesToScan(['20261001', '20261002'], '20261009')).toEqual(['20261001', '20261002']);   // 不到 8 个：全列
  });
  it('别的名字、写法和游标不同的照列；游标本身不合格就当没有', () => {
    const many = [...d12, '2026-09-01', 'manual'];
    expect(backupDatesToScan(many, '20261003')).toEqual(['2026-09-01', ...d12.slice(3), 'manual']);
    expect(backupDatesToScan(d12, 'zzz')).toEqual(d12);
    expect(backupDatesToScan([], '20261001')).toEqual([]);
  });
  it('审查 S1：日期名只认 YYYY-MM-DD 和 YYYYMMDD 两种', () => {
    for (const ok of ['2026-12-31', '20261231']) expect(BACKUP_DAY.test(ok), ok).toBe(true);
    for (const bad of ['2026-1231', '202610-01', '2026/12/31', '2026-12-3', '20261231x', '']) expect(BACKUP_DAY.test(bad), bad).toBe(false);
  });
});

describe('advanceBackupCursor：游标推到哪', () => {
  it('按顺序推；最后一个日期、不合格的名字、写法变了：不动，之后也不再推', () => {
    const st = { through: null as string | null, frozen: false };
    advanceBackupCursor(st, '20261001', false);
    advanceBackupCursor(st, '20261002', false);
    expect(st).toEqual({ through: '20261002', frozen: false });
    advanceBackupCursor(st, '2026-10-03', false);
    advanceBackupCursor(st, '20261004', false);
    expect(st).toEqual({ through: '20261002', frozen: true });
    const st2 = { through: null as string | null, frozen: false };
    advanceBackupCursor(st2, 'manual', false);
    advanceBackupCursor(st2, '20261009', false);
    expect(st2).toEqual({ through: null, frozen: true });
    const st3 = { through: '20261001', frozen: false };
    advanceBackupCursor(st3, '20261002', true);
    expect(st3).toEqual({ through: '20261001', frozen: true });
  });
});

describe('整轮跑：大账号不再每轮重列空日期', () => {
  it('400 个日期：几轮就删完；除了最后一个日期，每个日期最多列两次（删前一次、删后核对一次）', async () => {
    const w = world();
    await requestDeletion(w, A);
    seedDates(w.backups, 400);
    const listed = new Map<string, number>();
    const realList = w.backups.listUserFiles.bind(w.backups);
    w.backups.listUserFiles = async (d, u) => { if (u === A) listed.set(d, (listed.get(d) ?? 0) + 1); return realList(d, u); };
    toFirstRun(w);
    let rounds = 0;
    for (; rounds < 40 && w.db.users.has(A); rounds++) {
      await runPurge(w);
      w.clock.advance(15 * MIN);
    }
    expect(w.db.users.has(A)).toBe(false);
    expect(w.backups.count(A)).toBe(0);
    expect(w.backups.count(B)).toBe(400);   // B 没申请注销：一个不少
    const recent = new Set(Array.from({ length: BACKUP_RECENT_KEEP }, (_, i) => day(399 - i)));   // 最新 8 个每轮照列
    expect([...listed].filter(([d, n]) => !recent.has(d) && n > 2)).toEqual([]);
    expect(rounds < 28).toBe(true);   // 没有游标时本机实测要 28 轮（接手清单 PURGE-date-cursor）
  });

  it('停下时把游标写回：只往后推，不记最后一个日期；下一轮从游标后面接着做', async () => {
    const w = world();
    await requestDeletion(w, A);
    seedDates(w.backups, 400);
    toFirstRun(w);
    const seen: string[] = [];
    for (let i = 0; i < 40 && w.db.users.has(A); i++) {
      await runPurge(w);
      const c = w.db.pending.get(A)?.backups_done_through;
      if (c) seen.push(c);
      w.clock.advance(15 * MIN);
    }
    expect(seen.length > 0).toBe(true);
    expect([...seen].sort()).toEqual(seen);   // 单调不减
    expect(seen.includes(day(399))).toBe(false);
    expect(seen.every((c) => BACKUP_DAY.test(c))).toBe(true);
  });

  it('某个日期删完不为 0（failed）：游标停在它前一个日期，修好以后接着做', async () => {
    const w = world();
    await requestDeletion(w, A);
    seedDates(w.backups, 5);
    const realRemove = w.backups.remove.bind(w.backups);
    w.backups.remove = async (ps) => { await realRemove(ps.filter((p) => !p.startsWith(`${day(2)}/`))); };   // 第 3 个日期删不掉
    toFirstRun(w);
    const r = await runPurge(w);
    expect(r.body).toMatchObject({ failed: 1 });
    expect(w.db.pending.get(A)?.backups_done_through).toBe(day(1));
    w.backups.remove = realRemove;
    w.clock.advance(15 * MIN);
    await runPurge(w);
    expect(w.db.users.has(A)).toBe(false);
    expect(w.backups.count(A)).toBe(0);
  });

  it('审查 S3：游标等于最后一个日期（不大于游标）时，最后一个日期照样列、照样删', async () => {
    const w = world();
    await requestDeletion(w, A);
    seedDates(w.backups, 3);
    w.db.pending.get(A)!.backups_done_through = day(2);   // 直接摆成游标已到最后一个日期的状态（正常推不到这里，防的是写法变化等情况）
    toFirstRun(w);
    await runPurge(w);
    expect(w.db.users.has(A)).toBe(false);
    expect(w.backups.count(A)).toBe(0);
  });

  it('审查 M2：游标推过某天以后又往那天补写（前提“只往当天写”不成立），最新 8 个日期里的照样删掉', async () => {
    const w = world();
    await requestDeletion(w, A);
    seedDates(w.backups, 20);
    const realRemove = w.backups.remove.bind(w.backups);
    w.backups.remove = async (ps) => { await realRemove(ps.filter((p) => !p.startsWith(`${day(17)}/`))); };   // 第一轮在 day(17) 停下
    toFirstRun(w);
    expect((await runPurge(w)).body).toMatchObject({ failed: 1 });
    expect(w.db.pending.get(A)?.backups_done_through).toBe(day(16));   // 游标已推过 day(14)
    w.backups.remove = realRemove;
    w.backups.files.add(`${day(14)}/${A}/late.json.gz`);   // 往已确认删空的 day(14)（最新 8 个之内）补写
    w.clock.advance(15 * MIN);
    await runPurge(w);
    expect(w.db.users.has(A)).toBe(false);
    expect(w.backups.count(A)).toBe(0);
    expect(w.backups.count(B)).toBe(20);
  });

  it('游标不是自己的认领时刻对应的（别人的认领、没有行）：读出来是空，从头列', async () => {
    const w = world();
    await requestDeletion(w, A);
    seedDates(w.backups, 3);
    const store = w.db.purgeStore();
    w.db.pending.get(A)!.backups_done_through = day(1);
    expect(await store.backupsCursor(A, 'not-my-claim')).toBe(null);
    expect(await store.backupsCursor('00000000-0000-4000-8000-000000000000', 'x')).toBe(null);
  });
});
