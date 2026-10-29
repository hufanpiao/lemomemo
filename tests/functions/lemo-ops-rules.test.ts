// lemo-ops 的其余规则（架构 6.1）：配置、其他心跳阈值、长事务、清理慢批、钩子出错、每天的保活和用量、状态存取。
// TC-B1-94、TC-B1-102 的用例在 lemo-ops.test.ts；wrangler.toml 和变量样板的核对在 tests/build/lemo-ops-config.test.ts。
import { describe, expect, it } from 'vitest';
import { emptyState, loadBudget, loadState, plan } from '../../workers/lemo-ops/src/alerts.ts';
import { readConfig, type Env } from '../../workers/lemo-ops/src/index.ts';
import { AUTH_MAIL_HOUR_LIMIT, evaluateAuthMail, evaluateUsage, fmtAge, parseHeartbeatReport } from '../../workers/lemo-ops/src/rules.ts';
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

describe('发信量（架构 0.38 第 12 条、15.6 第 4d 条 ①）', () => {
  const subj = (w: ReturnType<typeof world>) => w.inbox.map((m) => m.subject);
  /** 往后走一轮（15 分钟），心跳都设成刚写过 */
  const step = async (w: ReturnType<typeof world>, n = 1) => {
    for (let i = 0; i < n; i++) {
      w.advance(15 * M);
      w.freshAll();
      await w.tick();
    }
  };
  const HOUR = '【柠檬记监控】验证码邮件一小时内发得太多';
  const DAY = '【柠檬记监控】Resend 当天额度用了超过 70%';
  const UNREADABLE = '【柠檬记监控】发信量读不到';
  const RESEND_UNREADABLE = '【柠檬记监控】Resend 用量读不到';

  it('阈值：验证码 1 小时超过 20 封才报（20 不报）；Resend 24 小时超过 100 封的 70% 才报（70 不报）；Resend 没接不查', () => {
    const keys = (am: Parameters<typeof evaluateAuthMail>[0]) => evaluateAuthMail(am).active.map((i) => i.key);
    expect(keys({ auth_1h: AUTH_MAIL_HOUR_LIMIT, resend_24h: 70 })).toEqual([]);
    expect(keys({ auth_1h: 21, resend_24h: 70 })).toEqual(['mail:hour']);
    expect(keys({ auth_1h: 0, resend_24h: 71 })).toEqual(['mail:day']);
    expect(keys({ auth_1h: 30, resend_24h: 100 })).toEqual(['mail:hour', 'mail:day']);
    expect(keys({ auth_1h: 30, resend_24h: null })).toEqual(['mail:hour']);
    expect(evaluateAuthMail({ auth_1h: 0, resend_24h: null }).drop).toEqual(['mail:day', 'mail:resend-unreadable']);
    expect(keys(null)).toEqual(['mail:unreadable']);
    // Resend 那项读不到（OPS-mail-sugg ②）：报“Resend 用量读不到”、mail:hour 照常判；mail:day 不在 scopes 也不在 drop（原样保留）
    const bad = evaluateAuthMail({ auth_1h: 30, resend_24h: null, resend_unreadable: true });
    expect(bad.active.map((i) => i.key)).toEqual(['mail:hour', 'mail:resend-unreadable']);
    expect(bad.scopes).not.toContain('mail:day');
    expect(bad.drop ?? []).toEqual([]);
    expect(keys({ auth_1h: 0, resend_24h: null, resend_unreadable: true })).toEqual(['mail:resend-unreadable']);
    // 读到了：resend-unreadable 也在查过的范围里（之后能判“已恢复”）
    expect(evaluateAuthMail({ auth_1h: 0, resend_24h: 3 }).scopes).toContain('mail:resend-unreadable');
  });

  it('没接（usage-report 不带 auth_mail）：不查、不告警', async () => {
    const w = world();
    w.freshAll();
    await w.tick();
    expect(w.inbox).toHaveLength(0);
  });

  it('验证码 30 封：正文写清是 Supabase Auth 的验证码、封数、上限和手册；数字变了不算新的一件事；连续 2 轮正常发“已恢复”', async () => {
    const w = world();
    w.freshAll();
    w.setAuthMail({ auth_1h: 30 });
    await w.tick();
    expect(subj(w)).toEqual([HOUR]);
    const text = w.inbox[0]?.text ?? '';
    expect(text).toContain('过去 1 小时 Supabase Auth 发出验证码邮件 30 封，超过 20 封');
    expect(text).toContain('每小时上限 30 封');
    expect(text).toContain('15.6 第 4d 条');
    w.setAuthMail({ auth_1h: 28 });
    await step(w);
    expect(w.inbox).toHaveLength(1);
    w.setAuthMail({ auth_1h: 3 });
    await step(w, 2);
    expect(subj(w)).toEqual([HOUR, '【柠檬记监控】已恢复：验证码邮件一小时内发得太多']);
  });

  it('Resend 当天超过 70%：正文写的是 Resend 合计（不是验证码数）', async () => {
    const w = world();
    w.freshAll();
    w.setAuthMail({ auth_1h: 5, resend_24h: 71 });
    await w.tick();
    expect(subj(w)).toEqual([DAY]);
    expect(w.inbox[0]?.text).toContain('过去 24 小时经 Resend 发出邮件共 71 封');
    expect(w.inbox[0]?.text).toContain('合计');
  });

  it('两件同时发生、之后同时恢复：各发一封告警、各发一封“已恢复”', async () => {
    const w = world();
    w.freshAll();
    w.setAuthMail({ auth_1h: 25, resend_24h: 90 });
    await w.tick();
    expect(subj(w).sort()).toEqual([DAY, HOUR].sort());
    w.setAuthMail({ auth_1h: 1, resend_24h: 10 });
    await step(w, 2);
    expect(subj(w).slice(2).sort()).toEqual(['【柠檬记监控】已恢复：Resend 当天额度用了超过 70%', '【柠檬记监控】已恢复：验证码邮件一小时内发得太多'].sort());
    await step(w, 3);
    expect(w.inbox).toHaveLength(4);
  });

  it('读不到：只报“读不到”，心跳照常检查；读不到期间不把已报的“发得太多”判成已恢复；读到后发“已恢复：读不到”', async () => {
    const w = world();
    w.freshAll();
    w.setAuthMail({ auth_1h: 25 });
    await w.tick();
    expect(subj(w)).toEqual([HOUR]);
    w.setAuthMail('error');
    w.advance(15 * M);
    w.freshAll();
    w.setHeartbeat('push-dispatch', 6 * M);
    await w.tick();
    expect(subj(w).slice(1).sort()).toEqual(['【柠檬记监控】推送服务（push-dispatch）停了', UNREADABLE].sort());
    await step(w, 2);
    expect(subj(w).filter((s) => s.includes('验证码邮件一小时内'))).toEqual([HOUR]);   // 读不到的几轮不算恢复
    w.setAuthMail({ auth_1h: 25 });
    await step(w, 2);
    expect(subj(w)).toContain('【柠檬记监控】已恢复：发信量读不到');
    expect(subj(w)).not.toContain('【柠檬记监控】已恢复：验证码邮件一小时内发得太多');
  });

  it('监控连不上时不动发信量的状态（不报“已恢复”）', async () => {
    const w = world();
    w.freshAll();
    w.setAuthMail({ auth_1h: 25 });
    await w.tick();
    w.setMode('network');
    await step(w, 3);
    expect(subj(w).filter((s) => s.includes('已恢复'))).toEqual([]);
  });

  it('没接以后（auth_mail 不再出现）：留下的状态悄悄删掉，不发“已恢复”；Resend 那项变成没接也一样', async () => {
    const w = world();
    w.freshAll();
    w.setAuthMail({ auth_1h: 25, resend_24h: 80 });
    await w.tick();
    expect(w.inbox).toHaveLength(2);
    w.setAuthMail({ auth_1h: 25, resend_24h: null });
    await step(w, 3);
    expect(w.inbox).toHaveLength(2);
    w.setAuthMail(undefined);
    await step(w, 3);
    expect(w.inbox).toHaveLength(2);
  });

  it('只有 resend_24h 不对：置 null 并标成读不到、保留好的 auth_1h，记 auth_mail:bad_resend；auth_1h 照常判（OPS-mail-src 复查建议、OPS-mail-sugg ②）', async () => {
    const base = { ok: true, heartbeats: [], pending_deletions: [], long_tx: 0 };
    for (const d of [-2, 1.5, '70', true, {}]) {
      const logs: string[] = [];
      const r = parseHeartbeatReport({ ...base, auth_mail: { auth_1h: 21, resend_24h: d } }, (c) => logs.push(c));
      expect(r?.auth_mail).toEqual({ auth_1h: 21, resend_24h: null, resend_unreadable: true });
      expect(logs).toEqual(['auth_mail:bad_resend']);
    }
    // usage-report 已经标了 resend_unreadable：照收（不是 undefined / false 都算），不再记日志；false 等于没标
    for (const f of [true, 1, 'yes']) {
      const logs: string[] = [];
      expect(parseHeartbeatReport({ ...base, auth_mail: { auth_1h: 2, resend_24h: null, resend_unreadable: f } }, (c) => logs.push(c))?.auth_mail).toEqual({
        auth_1h: 2,
        resend_24h: null,
        resend_unreadable: true,
      });
      expect(logs).toEqual([]);
    }
    expect(parseHeartbeatReport({ ...base, auth_mail: { auth_1h: 2, resend_24h: null, resend_unreadable: false } })?.auth_mail).toEqual({ auth_1h: 2, resend_24h: null });
    // 好的不记日志；auth_1h 坏了整个为 null，不另记 bad_resend
    const logs: string[] = [];
    parseHeartbeatReport({ ...base, auth_mail: { auth_1h: 3, resend_24h: 4 } }, (c) => logs.push(c));
    parseHeartbeatReport({ ...base, auth_mail: { auth_1h: -1, resend_24h: 'x' } }, (c) => logs.push(c));
    expect(logs).toEqual([]);
    // 端到端（经真的 usage-report core）：usage-report 先把坏的 resend_24h 置 null、标 resend_unreadable（它自己的日志记 auth_mail:bad_resend），
    // lemo-ops 收到 {auth_1h: 30, resend_24h: null, resend_unreadable: true}：照常报“发得太多”，另报“Resend 用量读不到”，不报整个“读不到”
    const w = world();
    w.freshAll();
    w.setAuthMail({ auth_1h: 30, resend_24h: -5 });
    await w.tick();
    expect(subj(w).sort()).toEqual([HOUR, RESEND_UNREADABLE].sort());
    expect(w.inbox.find((m) => m.subject === RESEND_UNREADABLE)?.text).toContain('auth_mail:bad_resend');
    expect(w.logs).not.toContain('auth_mail:bad_resend');
  });

  it('已在报的 Resend 超 70% 遇到坏数据：mail:day 原样保留（不删、不判已恢复），读到后照常判（OPS-mail-sugg ②）', async () => {
    const w = world();
    const issues = () => (JSON.parse(w.kv.get('alert-state:heartbeat:v2') ?? '{}') as { issues: Record<string, unknown> }).issues;
    w.freshAll();
    w.setAuthMail({ auth_1h: 5, resend_24h: 80 });
    await w.tick();
    expect(subj(w)).toEqual([DAY]);
    const before = issues()['mail:day'];
    expect(before).toBeDefined();
    // 坏数据（经真的 usage-report core）：连续 3 轮
    w.setAuthMail({ auth_1h: 5, resend_24h: 'x' });
    await step(w, 3);
    expect(subj(w)).toEqual([DAY, RESEND_UNREADABLE]);
    expect(issues()['mail:day']).toEqual(before);   // 状态一字不动：okRounds 不涨，不会判成已恢复
    // 读到了，还超：不当成新的一件事（6 小时内不重发），“Resend 用量读不到”发“已恢复”
    w.setAuthMail({ auth_1h: 5, resend_24h: 85 });
    await step(w, 2);
    expect(subj(w)).toEqual([DAY, RESEND_UNREADABLE, '【柠檬记监控】已恢复：Resend 用量读不到']);
    // 降下来：照常发“已恢复：Resend 当天额度……”
    w.setAuthMail({ auth_1h: 5, resend_24h: 10 });
    await step(w, 2);
    expect(subj(w)).toContain('【柠檬记监控】已恢复：Resend 当天额度用了超过 70%');
  });

  it('坏数据和好数据交替：“Resend 用量读不到”只发一封，不反复发、也不发“已恢复”（OPS-mail-sugg ②）', async () => {
    const w = world();
    w.freshAll();
    for (let i = 0; i < 3; i++) {
      w.setAuthMail({ auth_1h: 5, resend_24h: 'x' });
      await step(w);
      w.setAuthMail({ auth_1h: 5, resend_24h: 10 });
      await step(w);
    }
    expect(subj(w)).toEqual([RESEND_UNREADABLE]);
  });

  it('resend_unreadable 是 "false"、null 等任何非 undefined、非 false 的值都按读不到（OPS-mail-sugg ②）', () => {
    const base = { ok: true, heartbeats: [], pending_deletions: [], long_tx: 0 };
    const unreadable = { auth_1h: 2, resend_24h: null, resend_unreadable: true };
    for (const f of ['false', null, 0, '']) {
      expect(parseHeartbeatReport({ ...base, auth_mail: { auth_1h: 2, resend_24h: null, resend_unreadable: f } })?.auth_mail).toEqual(unreadable);
    }
  });

  it('resend_unreadable 和合法的 resend_24h 同时出现：以标记为准（OPS-mail-sugg ②）', () => {
    const base = { ok: true, heartbeats: [], pending_deletions: [], long_tx: 0 };
    const unreadable = { auth_1h: 2, resend_24h: null, resend_unreadable: true };
    // 合法的 90（超 70%）：不报 mail:day、报“Resend 用量读不到”
    const r = parseHeartbeatReport({ ...base, auth_mail: { auth_1h: 2, resend_24h: 90, resend_unreadable: true } });
    expect(r?.auth_mail).toEqual(unreadable);
    expect(evaluateAuthMail(r?.auth_mail ?? null).active.map((i) => i.key)).toEqual(['mail:resend-unreadable']);
  });

  it('真的没接（resend_24h 为 null、没有标记）：照旧把 mail:day 和“Resend 用量读不到”悄悄删掉（OPS-mail-sugg ②）', async () => {
    const w = world();
    const issues = () => (JSON.parse(w.kv.get('alert-state:heartbeat:v2') ?? '{}') as { issues: Record<string, unknown> }).issues;
    w.freshAll();
    w.setAuthMail({ auth_1h: 5, resend_24h: 80 });
    await w.tick();
    w.setAuthMail({ auth_1h: 5, resend_24h: 'x' });
    await step(w);
    expect(Object.keys(issues()).sort()).toEqual(['mail:day', 'mail:resend-unreadable']);
    w.setAuthMail({ auth_1h: 5, resend_24h: null });
    await step(w);
    expect(issues()['mail:day']).toBeUndefined();
    expect(issues()['mail:resend-unreadable']).toBeUndefined();
    await step(w, 3);
    expect(subj(w)).toEqual([DAY, RESEND_UNREADABLE]);   // 不发任何“已恢复”
  });

  it('auth_mail 形状不对只降级成 null（报“读不到”），不让整份返回体解析失败；多出的键忽略', async () => {
    const base = { ok: true, heartbeats: [], pending_deletions: [], long_tx: 0 };
    expect(parseHeartbeatReport(base)?.auth_mail).toBeUndefined();
    expect(parseHeartbeatReport({ ...base, auth_mail: null })?.auth_mail).toBeNull();
    expect(parseHeartbeatReport({ ...base, auth_mail: { auth_1h: 1 } })?.auth_mail).toEqual({ auth_1h: 1, resend_24h: null });
    expect(parseHeartbeatReport({ ...base, auth_mail: { auth_1h: 1, resend_24h: 2, extra: 'x' }, extra_top: [1] })?.auth_mail).toEqual({ auth_1h: 1, resend_24h: 2 });
    for (const bad of [{ auth_1h: '1' }, { auth_1h: -1 }, { auth_1h: 1.5 }, { auth_1h: -1, resend_24h: -2 }, { resend_24h: 2 }, { sent_1h: 1, sent_24h: 2 }, 5, []]) {
      const r = parseHeartbeatReport({ ...base, auth_mail: bad });
      expect(r).not.toBeNull();
      expect(r?.auth_mail).toBeNull();
    }
    // 端到端：usage-report 那边坏形状已降级成 null，lemo-ops 只报“读不到”，不报“监控连不上服务器”
    const w = world();
    w.freshAll();
    w.setAuthMail({ sent_1h: 1, sent_24h: 2 });
    await w.tick();
    expect(subj(w)).toEqual([UNREADABLE]);
  });
});
