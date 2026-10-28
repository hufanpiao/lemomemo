// lemo-ops 的其余规则（架构 6.1）：配置、其他心跳阈值、长事务、清理慢批、钩子出错、每天的保活和用量、状态存取。
// TC-B1-94、TC-B1-102 的用例在 lemo-ops.test.ts；wrangler.toml 和变量样板的核对在 tests/build/lemo-ops-config.test.ts。
import { describe, expect, it } from 'vitest';
import { emptyState, loadBudget, loadState, plan } from '../../workers/lemo-ops/src/alerts.ts';
import { readConfig, type Env } from '../../workers/lemo-ops/src/index.ts';
import { evaluateUsage, fmtAge } from '../../workers/lemo-ops/src/rules.ts';
import { H, M, SECRET, T0, world } from './lemo-ops-harness.ts';

describe('配置', () => {
  it('缺哪项只报名字，不报值', () => {
    const w = world();
    const env = { ...w.env, OPS_SECRET: '', ALERT_TO: '' } as Env;
    expect(() => readConfig(env)).toThrow('lemo-ops 配置缺：OPS_SECRET、ALERT_TO');
  });

  it('SUPABASE_URL 必须是 https、只写到域名（直连 <ref>.supabase.co，不经 /sb）', () => {
    const w = world();
    expect(readConfig(w.env).supabaseUrl).toBe('https://ref.supabase.co');
    expect(() => readConfig({ ...w.env, SUPABASE_URL: 'http://ref.supabase.co' })).toThrow('https');
    expect(() => readConfig({ ...w.env, SUPABASE_URL: 'https://lemomemo.com/sb' })).toThrow('只写到域名');
    expect(readConfig({ ...w.env, SUPABASE_URL: 'http://127.0.0.1:54321' }).supabaseUrl).toBe('http://127.0.0.1:54321');
  });
});

describe('其他心跳规则（架构 6.1）', () => {
  it.each([
    ['push-dispatch', 5 * M],
    ['ai-classify', 15 * M],
    ['backup-daily', 26 * H],
    ['vault-file-sweep', 10 * M],
    ['cleanup', 26 * H],
  ])('%s 超过阈值才告警', async (name, limit) => {
    const w = world();
    w.freshAll();
    w.setHeartbeat(name, limit);
    await w.tick();
    expect(w.inbox).toHaveLength(0);
    w.setHeartbeat(name, limit + 1000);
    await w.tick();
    expect(w.inbox).toHaveLength(1);
  });

  it('还没上线的函数（没有心跳行）不告警；写进 REQUIRED_HEARTBEATS 的没有行就告警', async () => {
    const w = world();
    await w.tick();
    expect(w.inbox).toHaveLength(0);
    w.env.REQUIRED_HEARTBEATS = 'account-purge, push-dispatch';
    w.dropHeartbeat('push-dispatch');
    await w.tick();
    expect(w.inbox.map((m) => m.subject).sort()).toEqual(['【柠檬记监控】推送服务（push-dispatch）从没写过心跳', '【柠檬记监控】注销到期删除（account-purge）从没写过心跳']);
  });

  it('从 REQUIRED_HEARTBEATS 删掉的名字：状态悄悄删掉，不报“已恢复”', async () => {
    const w = world();
    w.env.REQUIRED_HEARTBEATS = 'push-dispatch';
    await w.tick();
    expect(w.inbox).toHaveLength(1);
    w.env.REQUIRED_HEARTBEATS = '';
    for (let i = 0; i < 3; i++) {
      w.advance(15 * M);
      await w.tick();
    }
    expect(w.inbox).toHaveLength(1);
    expect((JSON.parse(w.kv.get('alert-state:heartbeat:v2') ?? '{}') as { issues: object }).issues).toEqual({});
  });

  it('长事务、30 天清理单批超过 2 分钟（只看最近 30 分钟写的）', async () => {
    const w = world();
    w.freshAll();
    w.setLongTx(1);
    w.setCleanup(130_000, 40 * M);
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】数据库有超过 4 分钟的长事务']);
    w.setCleanup(130_000, M);
    await w.tick();
    expect(w.inbox.map((m) => m.subject).slice(1)).toEqual(['【柠檬记监控】30 天清理单批超过 2 分钟']);
  });

  it('推送一轮里超过一半失败（detail 的 sent、failed）', async () => {
    const w = world();
    w.freshAll();
    w.setPushDetail({ sent: 5, failed: 5 });
    await w.tick();
    expect(w.inbox).toHaveLength(0);
    w.setPushDetail({ sent: 4, failed: 6 });
    await w.tick();
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】推送一轮里超过一半失败']);
    expect(w.inbox[0]?.text).toContain('成功 4 条、失败 6 条');
  });

  it('邮件里不带 OPS_SECRET、anon key、Resend 密钥', async () => {
    const w = world();
    w.setMode('db_error');
    await w.tick();
    const all = JSON.stringify(w.inbox.map(({ auth: _a, ...m }) => m));
    for (const s of [SECRET, 'test-anon', 'test-resend']) expect(all).not.toContain(s);
  });
});

describe('每天一次：保活和用量', () => {
  it('保活：GET app_config；失败发告警、连续 2 天好了发“已恢复”；USAGE_CHECK 没开时不调 usage', async () => {
    const w = world();
    await w.daily();
    expect(w.calls).toEqual(['GET https://ref.supabase.co/rest/v1/app_config?select=min_client_version']);
    expect(w.inbox).toHaveLength(0);
    w.setKeepalive(503);
    await w.daily();
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】每天的保活查询失败']);
    w.setKeepalive(200);
    for (let i = 0; i < 2; i++) {
      w.advance(24 * H);
      await w.daily();
    }
    expect(w.inbox.map((m) => m.subject).slice(1)).toEqual(['【柠檬记监控】已恢复：每天的保活查询失败']);
  });

  it('USAGE_CHECK=on：标题不带百分比（百分比写在正文）；升到紧急线马上再告知；百分比变了不重发', async () => {
    const w = world();
    w.env.USAGE_CHECK = 'on';
    w.setUsage({ ok: true, items: [{ key: 'supabase_storage', label: 'Supabase 文件存储', pct: 72 }, { key: 'db', label: '数据库', pct: 50 }] });
    await w.daily();
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】Supabase 文件存储超过提醒线']);
    expect(w.inbox[0]?.text).toContain('现在 72%');
    w.advance(3 * H);
    w.setUsage({ ok: true, items: [{ key: 'supabase_storage', label: 'Supabase 文件存储', pct: 75 }] });
    await w.daily();
    expect(w.inbox).toHaveLength(1);
    w.setUsage({ ok: true, items: [{ key: 'supabase_storage', label: 'Supabase 文件存储', pct: 91 }] });
    await w.daily();
    expect(w.inbox.map((m) => m.subject)[1]).toBe('【柠檬记监控】Supabase 文件存储到紧急线');
  });

  it('审查必改 2：用量查询失败以后查成功了，连续 2 次成功发“已恢复”', async () => {
    const w = world();
    w.env.USAGE_CHECK = 'on';
    w.setUsage({ bad: 1 });
    await w.daily();
    expect(w.inbox.map((m) => m.subject)).toEqual(['【柠檬记监控】每天的用量查询失败']);
    w.setUsage({ ok: true, items: [] });
    for (let i = 0; i < 2; i++) {
      w.advance(24 * H);
      await w.daily();
    }
    expect(w.inbox.map((m) => m.subject).slice(1)).toEqual(['【柠檬记监控】已恢复：每天的用量查询失败']);
    expect((JSON.parse(w.kv.get('alert-state:daily:v2') ?? '{}') as { issues: object }).issues).toEqual({});
  });

  it('关掉 USAGE_CHECK 后，用量状态悄悄删掉', async () => {
    const w = world();
    w.env.USAGE_CHECK = 'on';
    w.setUsage({ bad: 1 });
    await w.daily();
    w.env.USAGE_CHECK = 'off';
    w.advance(24 * H);
    await w.daily();
    expect(w.inbox).toHaveLength(1);
    expect((JSON.parse(w.kv.get('alert-state:daily:v2') ?? '{}') as { issues: object }).issues).toEqual({});
  });

  it('R2 存储 80% 提醒、100% 已开始收费；R2 操作次数 70%', () => {
    const t = (key: string, pct: number) => evaluateUsage([{ key, label: key, pct }]).active.map((i) => i.title);
    expect(t('r2_storage', 79)).toEqual([]);
    expect(t('r2_storage', 80)).toEqual(['r2_storage超过提醒线']);
    expect(t('r2_storage', 100)).toEqual(['r2_storage到紧急线（已开始收费）']);
    expect(t('r2_ops_write', 70)).toEqual(['r2_ops_write超过提醒线']);
  });
});

describe('状态和小工具', () => {
  it('KV 里的状态、额度坏了就当没有（最多多发一次，不会漏）', async () => {
    const store = { get: async () => '{bad json', put: async () => {} };
    expect(await loadState(store, 'heartbeat')).toEqual(emptyState());
    expect(await loadBudget(store, T0)).toEqual({ day: '2026-10-29', sent: 0, capNotice: false });
  });

  it('没有变化不写 KV', () => {
    const r = plan(emptyState(), { day: '2026-10-29', sent: 0, capNotice: false }, [{ active: [], scopes: ['unreachable'] }], T0);
    expect(r.changed).toBe(false);
    expect(r.planned).toEqual([]);
  });

  it('fmtAge', () => {
    expect(fmtAge(59)).toBe('0 分');
    expect(fmtAge(26 * 3600 + 60)).toBe('26 小时 1 分');
    expect(fmtAge(3 * 24 * 3600)).toBe('3 天 0 小时');
  });
});
