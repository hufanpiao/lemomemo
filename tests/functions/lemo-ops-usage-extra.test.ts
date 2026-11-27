// lemo-ops 每天用量检查的 B7a 部分（workers/lemo-ops/src/usage-extra.ts）：读不到的项、导出分片到上限、单人存储 90%，
// 以及 storage-sweep、backup-pull 心跳 26 小时阈值和 backup-pull 快到上限的提示（B7a 复审第 5、8 条）。返回体格式照 supabase/functions/usage-report/usage.ts。
import { describe, expect, it } from 'vitest';
import { BACKUP_PULL_NEAR_LIMIT, evaluateBackupPullDetail } from '../../workers/lemo-ops/src/backup-pull.ts';
import { HEARTBEAT_LIMITS, HEARTBEAT_SCOPES } from '../../workers/lemo-ops/src/rules.ts';
import { PULL_HOURLY, WAIT_HOURLY } from '../../supabase/functions/backup-manifest/core.ts';
import { SWEEP_INCOMPLETE, evaluateSweepDetail } from '../../workers/lemo-ops/src/sweep.ts';
import { DETAIL_FIELDS_BY_NAME } from '../../supabase/functions/usage-report/core.ts';
import { USAGE_BACKUP_MISSING, USAGE_EXPORT_CAPPED, USAGE_UNREADABLE, evaluateUsageReport, parseUnreadable } from '../../workers/lemo-ops/src/usage-extra.ts';
import { H, M, world } from './lemo-ops-harness.ts';

const item = (key: string, pct: number) => ({ key, label: key, pct });

describe('evaluateUsageReport', () => {
  it('都读到、没人到导出上限：和 evaluateUsage 一样（整组 usage: 都算查过）', () => {
    const ev = evaluateUsageReport({ ok: true, items: [], unreadable: [], export_capped: 0, backup_missing: 0 }, [item('db', 10)]);
    expect(ev).toEqual({ active: [], scopes: ['usage:', 'usage-call'] });
  });

  it('有读不到的：报“有几项用量读不到”（标题不带项名），读不到那几项不在查过范围里（已有状态原样留着）', () => {
    const body = { ok: true, items: [item('db', 10)], unreadable: [{ key: 'r2_storage', label: 'R2 存储' }], export_capped: 0, backup_missing: 0 };
    const ev = evaluateUsageReport(body, body.items);
    expect(ev.active.map((i) => [i.key, i.title])).toEqual([[USAGE_UNREADABLE, '有几项用量读不到']]);
    expect(ev.active[0]?.lines[0]).toContain('R2 存储');
    expect(ev.scopes).toContain('usage:db');
    expect(ev.scopes).toContain('usage-call');
    expect(ev.scopes).not.toContain('usage:r2_storage');
    expect(ev.scopes).not.toContain('usage:');
  });

  it('导出分片到上限的账号数 > 0 提醒；读不到（null）时这一项不算查过', () => {
    const ev = evaluateUsageReport({ ok: true, items: [], unreadable: [], export_capped: 2 }, []);
    expect(ev.active.map((i) => i.key)).toEqual([USAGE_EXPORT_CAPPED]);
    expect(ev.active[0]?.lines[0]).toContain('2 个账号');
    const nul = evaluateUsageReport({ ok: true, items: [], unreadable: [], export_capped: null, backup_missing: 0 }, []);
    expect(nul.active).toEqual([]);
    expect(nul.scopes).not.toContain(USAGE_EXPORT_CAPPED);
  });

  it('B7a 评审第 11 条：首尔今天没备份的账号数 > 0 提醒；读不到（null）时这一项不算查过（已有状态原样留着）', () => {
    const ev = evaluateUsageReport({ ok: true, items: [], unreadable: [], export_capped: 0, backup_missing: 3 }, []);
    expect(ev.active.map((i) => i.key)).toEqual([USAGE_BACKUP_MISSING]);
    expect(ev.active[0]?.title).toBe('今天有账号没有服务器备份');
    expect(ev.active[0]?.lines[0]).toContain('3 个账号');
    expect(ev.scopes).toEqual(['usage:', 'usage-call']);   // 都读到：整组 usage: 都算查过（含 usage:backup_missing）
    const nul = evaluateUsageReport({ ok: true, items: [], unreadable: [{ key: 'backup_missing', label: '今天没有服务器备份的账号数' }], export_capped: 0, backup_missing: null }, []);
    expect(nul.active.map((i) => i.key)).toEqual([USAGE_UNREADABLE]);
    expect(nul.scopes).not.toContain(USAGE_BACKUP_MISSING);
    expect(nul.scopes).not.toContain('usage:');
  });

  it('unreadable 形状不对的项跳过，不连累整份', () => {
    expect(parseUnreadable({ unreadable: [{ key: 'a', label: 'A' }, { key: 1 }, 'x'] })).toEqual([{ key: 'a', label: 'A' }]);
    expect(parseUnreadable({})).toEqual([]);
  });
});

describe('lemo-ops 每天一轮（USAGE_CHECK=on）', () => {
  it('单个账号存储到 90% 提醒；R2 读不到的那一轮不发“已恢复”，读回来以后照常判', async () => {
    const w = world();
    w.env.USAGE_CHECK = 'on';
    w.setUsage({ ok: true, items: [item('user_media', 89), item('r2_storage', 85)], unreadable: [], export_capped: 0, backup_missing: 0 });
    await w.daily();
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】r2_storage超过提醒线']);
    w.setUsage({ ok: true, items: [item('user_media', 90)], unreadable: [{ key: 'r2_storage', label: 'R2 存储' }], export_capped: 0, backup_missing: 0 });
    for (let i = 0; i < 3; i++) {
      w.advance(24 * H);
      await w.daily();
    }
    const subjects = w.inbox.map((m) => m.subject);
    expect(subjects).toContain('【柠檬记监控】user_media超过提醒线');
    expect(subjects).toContain('【柠檬记监控】有几项用量读不到');
    expect(subjects).not.toContain('【柠檬记监控】已恢复：r2_storage超过提醒线');
  });
});

describe('storage-sweep 心跳', () => {
  it('阈值 26 小时', async () => {
    expect(HEARTBEAT_LIMITS['storage-sweep']?.limitS).toBe(26 * 3600);
    const w = world();
    w.freshAll();
    w.setHeartbeat('storage-sweep', 26 * H);
    await w.tick();
    expect(w.inbox).toHaveLength(0);
    w.setHeartbeat('storage-sweep', 26 * H + M);
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】文件清理（storage-sweep）停了']);
  });

  it('B7a 评审第 10 条：budget_hit、cap_hit 为真时报“文件清理一轮没做完”；usage-report 白名单放行这几个字段', () => {
    expect(evaluateSweepDetail({ budget_hit: false, cap_hit: false, buckets_done: 4 })).toEqual([]);
    expect(evaluateSweepDetail(null)).toEqual([]);
    const b = evaluateSweepDetail({ budget_hit: true, cap_hit: false, buckets_done: 2 });
    expect(b.map((i) => [i.key, i.title])).toEqual([[SWEEP_INCOMPLETE, '文件清理一轮没做完']]);
    expect(b[0]?.lines[0]).toContain('2 个桶');
    expect(evaluateSweepDetail({ budget_hit: false, cap_hit: true })[0]?.lines[0]).toContain('上限');
    expect(HEARTBEAT_SCOPES).toContain('sweep:');
    expect(DETAIL_FIELDS_BY_NAME['storage-sweep']?.bool).toEqual(['budget_hit', 'cap_hit', 'backup_budget_hit', 'backup_cap_hit']);
    expect(DETAIL_FIELDS_BY_NAME['storage-sweep']?.num).toEqual(expect.arrayContaining(['buckets_done', 'backup_dates', 'backup_files']));
  });

  it('B7a 收口第 2 条：删过期服务器备份到了时间或个数上限也报“文件清理一轮没做完”，和 R2 那一段分开说', () => {
    for (const d of [{ backup_budget_hit: true }, { backup_cap_hit: true }]) {
      const b = evaluateSweepDetail({ budget_hit: false, cap_hit: false, buckets_done: 4, ...d });
      expect(b.map((i) => i.key)).toEqual([SWEEP_INCOMPLETE]);
      expect(b[0]?.lines[0]).toContain('服务器备份');
      expect(b[0]?.lines.join('')).not.toContain('个桶');
    }
  });
});

describe('backup-pull 心跳（B7a 复审第 5、8 条）', () => {
  it('阈值 26 小时：pull.ps1 一天没拉成功就报“备份拉回本机停了”', async () => {
    expect(HEARTBEAT_LIMITS['backup-pull']?.limitS).toBe(26 * 3600);
    const w = world();
    w.freshAll();
    w.setHeartbeat('storage-sweep', M);
    w.setHeartbeat('backup-pull', 26 * H);
    await w.tick();
    expect(w.inbox).toHaveLength(0);
    w.setHeartbeat('backup-pull', 26 * H + M);
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】备份拉回本机（pull.ps1）停了']);
  });

  it('快到每小时上限才提示：1000 个账号不报，拉一遍超过 70% 或等待间隔超过 5 分钟才报；usage-report 白名单放行这几个字段', () => {
    const d = (accounts: number) => {
      const p = Math.ceil(accounts / 50);
      return { accounts, pull_calls: 2 + 7 * p, pull_limit: PULL_HOURLY, wait_pages: p, wait_limit: WAIT_HOURLY };
    };
    expect(evaluateBackupPullDetail(null)).toEqual([]);
    expect(evaluateBackupPullDetail(d(1000))).toEqual([]);
    expect(evaluateBackupPullDetail(d(1450))).toEqual([]);   // 2 + 7 × 29 = 205 ≤ 210
    const near = evaluateBackupPullDetail(d(1500));         // 2 + 7 × 30 = 212 > 210
    expect(near.map((i) => [i.key, i.title])).toEqual([[BACKUP_PULL_NEAR_LIMIT, '备份拉取快到每小时上限了']]);
    expect(near[0]?.lines.join('')).toContain('212 次');
    // 只有等待慢：每轮 41 页 → 3600 × 41 ÷ 480 = 308 秒
    const slow = evaluateBackupPullDetail({ accounts: 2050, pull_calls: 10, pull_limit: PULL_HOURLY, wait_pages: 41, wait_limit: WAIT_HOURLY });
    expect(slow[0]?.lines.join('')).toContain('308 秒');
    expect(evaluateBackupPullDetail({ wait_pages: 40, wait_limit: WAIT_HOURLY })).toEqual([]);
    expect(HEARTBEAT_SCOPES).toContain('pull:');
    expect(DETAIL_FIELDS_BY_NAME['backup-pull']).toEqual({ num: ['accounts', 'pull_calls', 'pull_limit', 'wait_pages', 'wait_limit'], bool: [] });
  });
});
