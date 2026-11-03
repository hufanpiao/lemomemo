// push-dispatch 第 1～8 步（B2 任务单 BE-2；架构 5.3、6.1；架构审 D3 第 2～4、6 点；B2 安全审查“留给 BE-2 的条件”、六之四补 Topic 条件）。
// 推送服务用测试开发的替身 tests/fakes/push-service.ts（进程内 fake.fetch，开 VAPID 校验、解每条负载）；造数据按“少量设备、每台多条”。
// D3 第 6 点的“拖 3 秒、造 300 条、一轮 25 秒内返回”在 push-dispatch-budget.test.ts（耗时，进 node-slow）。
import { afterEach, describe, expect, it } from 'vitest';
import { actionsFor, hhmm, NOTIFY_ACTIONS, SNOOZE_MIN as SNOOZE_MIN_LOGIC } from '../../shared/logic/notify-text.ts';
import { handle } from '../../supabase/functions/push-dispatch/core.ts';
import { isDue, parseDnd, SNOOZE_MIN } from '../../supabase/functions/push-dispatch/round.ts';
import { createFakePush, newPushSubscriber, reply, type FakePushService, type PushSubscriber } from '../fakes/push-service.ts';
import { cronReq, depsFor, fakeVapid } from './push-dispatch-harness.ts';
import { eventRow, LOGIC, MemDb, todoRow, UA, UB, uuid } from './push-dispatch-mem.ts';

const SEOUL = 'Asia/Seoul';
let fakes: FakePushService[] = [];
afterEach(async () => {
  await Promise.all(fakes.map((f) => f.close()));
  fakes = [];
});

const fcm = () => `https://fcm.googleapis.com/fcm/send/${uuid('f')}`;
const apple = () => `https://web.push.apple.com/${uuid('a')}`;

async function world(endpoints: Record<string, string[]>, opt: { delayMs?: number } = {}) {
  const v = await fakeVapid();
  const db = new MemDb();
  const subs: PushSubscriber[] = [];
  const devOf = new Map<number, string>();
  for (const [user, eps] of Object.entries(endpoints)) {
    db.user(user);
    for (const ep of eps) {
      const s = await newPushSubscriber(ep);
      const d = db.device(user, { endpoint: ep, p256dh: s.p256dh, auth: s.auth });
      devOf.set(subs.length, d.id);
      subs.push(s);
    }
  }
  const f = createFakePush({ subscribers: subs, vapid: { publicKey: v.pub }, ...(opt.delayMs ? { delayMs: opt.delayMs } : {}) });
  fakes.push(f);
  const deps = (over: Parameters<typeof depsFor>[2] = {}) => depsFor(db, v.keys, { fetch: f.fetch, ...over });
  const pushes = () => f.requests.filter((r) => r.payload !== null).map((r) => ({ dev: devOf.get(r.subscriber?.index ?? -1), p: JSON.parse(r.payload as string) as Record<string, unknown>, headers: r.headers }));
  return { db, f, deps, pushes, v };
}

async function round(deps: ReturnType<typeof depsFor>) {
  const r = await handle(cronReq(), deps);
  expect(r.status).toBe(200);
  return (await r.json()) as { ok: true; claimed: number; sent: number; failed: number; budget_hit: boolean; left: number };
}

describe('第 1 步：到点查询（isDue）', () => {
  const now = 1_793_000_000_000;
  const r = (o: Partial<Parameters<typeof isDue>[1]>) => ({ ...todoRow(UA), ...o });
  it('due_at = greatest(remind_at, snooze_at, defer_until)；窗口 (now − 60 分钟, now + 60 秒]', () => {
    expect(isDue('todos', r({ remind_at: now }), now)).toBe(now);
    expect(isDue('todos', r({ remind_at: now + 60_000 }), now)).toBe(now + 60_000);
    expect(isDue('todos', r({ remind_at: now + 60_001 }), now)).toBeNull();
    expect(isDue('todos', r({ remind_at: now - 3_600_000 }), now)).toBeNull();
    expect(isDue('todos', r({ remind_at: now - 3_599_999 }), now)).toBe(now - 3_599_999);
    expect(isDue('todos', r({ remind_at: now - 7_200_000, snooze_at: now }), now)).toBe(now);
    expect(isDue('todos', r({ remind_at: now - 10, defer_until: now + 120_000 }), now)).toBeNull();
  });
  it('已推过这个 due_at、已按“知道了”、已删、已撤销、待办已完成、remind_at 为空的都不算', () => {
    expect(isDue('todos', r({ remind_at: now, pushed_for: now }), now)).toBeNull();
    expect(isDue('todos', r({ remind_at: now - 5, snooze_at: now, pushed_for: now - 5 }), now)).toBe(now);
    expect(isDue('todos', r({ remind_at: now, notified_for: now }), now)).toBeNull();
    expect(isDue('todos', r({ remind_at: now, deleted_at: 1 }), now)).toBeNull();
    expect(isDue('todos', r({ remind_at: now, undone: true }), now)).toBeNull();
    expect(isDue('todos', r({ remind_at: now, done: true }), now)).toBeNull();
    expect(isDue('events', { ...eventRow(UA), remind_at: now, done: true }, now)).toBe(now);
    expect(isDue('todos', r({ remind_at: null, snooze_at: now }), now)).toBeNull();
  });
  it('免打扰设置的解析：认不出的按没开', () => {
    expect(parseDnd({ start: '22:00', end: '07:00' })).toEqual({ start: '22:00', end: '07:00' });
    for (const v of [null, 'x', [], {}, { start: '22:00' }, { start: '25:00', end: '07:00' }, { start: '22:00', end: '22:00' }, { start: '22:00', end: '07:00', enabled: false }]) {
      expect(parseDnd(v)).toBeNull();
    }
  });
});

describe('第 3～5、7、8 步：认领、文案、发给所有设备、日志、心跳', () => {
  it('一条待办发给这个人的两台设备；负载对、不带 Topic；pushed_for = due_at；心跳四项；日志不带标题和地址', async () => {
    const eps = [fcm(), fcm()];
    const w = await world({ [UA]: eps });
    const now = Date.now();
    const t = w.db.put('todos', todoRow(UA, { title: '买柠檬', remind_at: now - 1000 }));
    const d = w.deps({ now: () => now });
    const body = await round(d);
    expect(body).toEqual({ ok: true, claimed: 1, sent: 1, failed: 0, budget_hit: false, left: 0 });
    expect(w.db.beats).toEqual([{ claimed: 1, sent: 1, failed: 0, budget_hit: false }]);
    const ps = w.pushes();
    expect(ps).toHaveLength(2);
    expect(new Set(ps.map((x) => x.dev)).size).toBe(2);
    for (const x of ps) {
      // R-294：两个按钮“推迟”（snooze）、“完成”（done）
      expect(x.p).toEqual({ v: 1, type: 'remind', user_id: UA, kind: 'todo', id: t.id, due_at: now - 1000, title: '买柠檬',
        snooze: { label: '推迟', minutes: 10 }, done: { label: '完成' } });
      expect(x.headers['topic']).toBeUndefined();
      expect(x.headers['urgency']).toBe('high');
    }
    for (const r of w.f.requests) expect(r.vapid?.ok).toBe(true);
    expect(w.db.tables.todos.get(t.id)?.pushed_for).toBe(now - 1000);
    expect(w.db.logs.filter((l) => l.act === 'push_ok')).toHaveLength(2);
    const text = JSON.stringify(w.db.logs);
    expect(text).not.toContain('买柠檬');
    for (const ep of eps) expect(text).not.toContain(ep);
    // 再跑一轮不重复发
    await round(w.deps({ now: () => now + 30_000 }));
    expect(w.pushes()).toHaveLength(2);
  });

  it('文案：日程“{time} {title}”；待办有截止时刻的正文“17:00 截止”；source = chat 加“来自 Claude ·”；韩文按 ui_locale', async () => {
    const w = await world({ [UA]: [fcm()], [UB]: [fcm()] });
    w.db.profs.set(UB, { current_tz: SEOUL, ui_locale: 'ko-KR' });
    const now = Date.now();
    const start = now + 15 * 60_000;
    const day = new Date(start + 9 * 3_600_000).toISOString().slice(0, 10);
    const e = w.db.put('events', eventRow(UA, { title: '会议', date: day, time: hhmm(start, SEOUL), tz: SEOUL, remind_at: now }));
    const t = w.db.put('todos', todoRow(UA, { title: '交报告', due_time: '17:00', source: 'chat', remind_at: now - 1 }));
    const k = w.db.put('todos', todoRow(UB, { title: '보고서', due_time: '17:00', remind_at: now - 2 }));
    await round(w.deps({ now: () => now }));
    const by = new Map(w.pushes().map((x) => [x.p['id'], x.p]));
    expect(by.get(e.id)).toMatchObject({ kind: 'event', title: `${hhmm(start, SEOUL)} 会议` });
    expect(by.get(e.id)?.['body']).toBeUndefined();
    expect(by.get(t.id)).toMatchObject({ title: '来自 Claude · 交报告', body: '17:00 截止' });
    expect(by.get(k.id)).toMatchObject({ title: '보고서', body: '17:00 마감', snooze: { label: '미루기', minutes: 10 }, done: { label: '완료' } });
    // R-308：日程是“推迟 + 知道了”，不带“完成”
    expect(by.get(e.id)).toMatchObject({ snooze: { label: '推迟', minutes: 10 }, ack: { label: '知道了' } });
    expect(by.get(e.id)?.['done']).toBeUndefined();
    expect(by.get(t.id)?.['ack']).toBeUndefined();
  });

  it('不写标题（条目 push_show_title = false，或它为空且设置 remind.show_title = false）：待办只写“几点有 1 项待办”、日程“几点有 1 项日程”（R-294），不带截止时刻', async () => {
    const w = await world({ [UA]: [fcm()], [UB]: [fcm()] });
    w.db.sets.set(UB, { 'remind.show_title': false });
    const now = Date.now();
    const a = w.db.put('todos', todoRow(UA, { title: '秘密', due_time: '17:00', push_show_title: false, remind_at: now }));
    const b = w.db.put('todos', todoRow(UB, { title: '秘密2', due_time: '17:00', remind_at: now }));
    const c = w.db.put('todos', todoRow(UB, { title: '照写', push_show_title: true, source: 'chat', remind_at: now - 1 }));
    const start = now + 15 * 60_000;
    const day = new Date(start + 9 * 3_600_000).toISOString().slice(0, 10);
    const e = w.db.put('events', eventRow(UA, { title: '秘密会议', date: day, time: hhmm(start, SEOUL), tz: SEOUL, push_show_title: false, remind_at: now - 2 }));
    await round(w.deps({ now: () => now }));
    const by = new Map(w.pushes().map((x) => [x.p['id'], x.p]));
    for (const id of [a.id, b.id]) {
      expect(by.get(id)?.['title']).toBe(`${hhmm(now, SEOUL)} 有 1 项待办`);
      expect(by.get(id)?.['body']).toBeUndefined();
    }
    expect(by.get(c.id)?.['title']).toBe('来自 Claude · 照写');
    expect(by.get(e.id)?.['title']).toBe(`${hhmm(start, SEOUL)} 有 1 项日程`);
    expect(JSON.stringify([...by.values()])).not.toContain('秘密');
  });

  it('R-307、R-308 按钮常量：round.ts 的 SNOOZE_MIN 和 shared/logic 的一致（10 分钟）；action 名 snooze、done、ack；按类型的按钮和 actionsFor 一致', () => {
    expect(SNOOZE_MIN).toBe(SNOOZE_MIN_LOGIC);
    expect(SNOOZE_MIN).toBe(10);
    expect(NOTIFY_ACTIONS.snooze).toEqual({ action: 'snooze', key: 'remind.push.action.snooze', minutes: SNOOZE_MIN });
    expect(NOTIFY_ACTIONS.done).toEqual({ action: 'done', key: 'remind.push.action.done' });
    expect(NOTIFY_ACTIONS.ack).toEqual({ action: 'ack', key: 'remind.push.action.ack' });
    expect(actionsFor('todo')).toEqual(['snooze', 'done']);
    expect(actionsFor('event')).toEqual(['snooze', 'ack']);
    expect(actionsFor('anniv')).toEqual(['snooze', 'ack']);
  });

  it('R-308：负载里的按钮字段正好是 actionsFor 给的两个（待办、日程各一条）', async () => {
    const w = await world({ [UA]: [fcm()] });
    const now = Date.now();
    const start = now + 15 * 60_000;
    const day = new Date(start + 9 * 3_600_000).toISOString().slice(0, 10);
    const t = w.db.put('todos', todoRow(UA, { title: 'T', remind_at: now }));
    const e = w.db.put('events', eventRow(UA, { title: 'E', date: day, time: hhmm(start, SEOUL), tz: SEOUL, remind_at: now - 1 }));
    await round(w.deps({ now: () => now }));
    const by = new Map(w.pushes().map((x) => [x.p['id'], x.p]));
    const buttons = (p: Record<string, unknown> | undefined) => (['snooze', 'done', 'ack'] as const).filter((k) => p?.[k] !== undefined);
    expect(buttons(by.get(t.id))).toEqual([...actionsFor('todo')]);
    expect(buttons(by.get(e.id))).toEqual([...actionsFor('event')]);
  });

  it('只给可用账号发；每人每轮最多 20 条，多的下一轮发', async () => {
    const w = await world({ [UA]: [fcm()], [UB]: [fcm()] });
    w.db.usable.set(UB, false);
    const now = Date.now();
    for (let i = 0; i < 25; i++) w.db.put('todos', todoRow(UA, { remind_at: now - 60_000 + i }));
    w.db.put('todos', todoRow(UB, { remind_at: now }));
    expect((await round(w.deps({ now: () => now }))).claimed).toBe(20);
    expect(w.pushes().every((x) => x.p['user_id'] === UA)).toBe(true);
    expect((await round(w.deps({ now: () => now + 60_000 }))).claimed).toBe(5);
    expect(w.pushes()).toHaveLength(25);
  });

  it('第 2 步免打扰：落在里面的写 defer_until = 结束时刻，这一轮不发；到了结束时刻照常发', async () => {
    const w = await world({ [UA]: [fcm()] });
    const now = Date.now();
    const m = (ms: number) => hhmm(ms, SEOUL);
    w.db.sets.set(UA, { 'remind.dnd': { start: m(now - 10 * 60_000), end: m(now + 30 * 60_000) } });
    const t = w.db.put('todos', todoRow(UA, { remind_at: now }));
    expect((await round(w.deps({ now: () => now }))).claimed).toBe(0);
    const until = w.db.tables.todos.get(t.id)?.defer_until as number;
    expect(m(until)).toBe(m(now + 30 * 60_000));
    expect(w.pushes()).toHaveLength(0);
    expect((await round(w.deps({ now: () => until }))).claimed).toBe(1);
    expect(w.pushes()[0]?.p['due_at']).toBe(until);
  });

  it('设备结果：410 删订阅（后面的条目不再发给它）；401 只加 push_fail_count；白名单外的端点不发、三列置空、记 push_bad_endpoint', async () => {
    const goneEp = fcm(), vapidEp = fcm(), okEp = fcm();
    const w = await world({ [UA]: [goneEp, vapidEp, okEp] });
    const bad = w.db.device(UA, { endpoint: 'https://evil.example.com/x', p256dh: w.db.devs[0]?.p256dh ?? '', auth: w.db.devs[0]?.auth ?? '' });
    w.f.addRule({ path: new URL(goneEp).pathname, reply: reply.gone() });
    w.f.addRule({ path: new URL(vapidEp).pathname, reply: reply.status(401) });
    const now = Date.now();
    w.db.put('todos', todoRow(UA, { remind_at: now - 2 }));
    w.db.put('todos', todoRow(UA, { remind_at: now - 1 }));
    // 并发 1：两条先后发，才看得出“第一条回 410 以后，第二条不再发给它”（并发时两条可能同时在飞，接受）
    const body = await round(w.deps({ now: () => now, limits: { concurrency: 1 } }));
    expect(body).toMatchObject({ claimed: 2, sent: 2, failed: 0 });
    const dev = (ep: string) => w.db.devs.find((d) => d.id === w.db.devs.find((x) => x.push_endpoint === ep || x.id === ep)?.id);
    const [g, v, o] = w.db.devs;
    expect([g?.push_endpoint, g?.p256dh, g?.auth]).toEqual([null, null, null]);
    expect(v?.push_endpoint).toBe(vapidEp);
    expect(v?.push_fail_count).toBe(2);
    expect(o?.push_fail_count).toBe(0);
    expect(dev(bad.id)?.push_endpoint).toBeNull();
    expect(w.f.requests.filter((r) => r.path === new URL(goneEp).pathname)).toHaveLength(1);   // 第二条不再发给已删订阅的
    expect(w.f.requests.some((r) => r.url.includes('evil'))).toBe(false);
    const be = w.db.logs.filter((l) => l.act === 'push_bad_endpoint');
    expect(be.map((l) => l.code)).toEqual(['host_not_allowed']);
    expect(JSON.stringify(w.db.logs)).not.toContain('evil.example.com');
    expect(w.db.logs.filter((l) => l.act === 'push_failed').map((l) => l.code).sort()).toEqual(['gone', 'vapid_rejected', 'vapid_rejected']);
  });

  it('全部设备都失败：这一条算 failed（claimed = sent + failed）；没有设备的人不认领', async () => {
    const ep = fcm();
    const w = await world({ [UA]: [ep] });
    w.db.user(UB);
    w.f.setDefault(reply.status(500));
    const now = Date.now();
    w.db.put('todos', todoRow(UA, { remind_at: now }));
    const nb = w.db.put('todos', todoRow(UB, { remind_at: now }));
    expect(await round(w.deps({ now: () => now }))).toMatchObject({ claimed: 1, sent: 0, failed: 1 });
    expect(w.db.tables.todos.get(nb.id)?.pushed_for).toBeNull();
  });
});

describe('Edge 的 resolve：主机属于 *.push.apple.com 的一律不发（不看 devices.platform）', () => {
  it('推过之后在别处按了“知道了”：给 FCM 那台发 resolve（不带标题），苹果那台不发；pushed_for 清掉，只发一次', async () => {
    const w = await world({ [UA]: [fcm(), apple()] });
    const now = Date.now();
    const X = now - 5 * 60_000;
    const t = w.db.put('todos', todoRow(UA, { title: '买柠檬', remind_at: X, pushed_for: X, notified_for: X }));
    await round(w.deps({ now: () => now }));
    const ps = w.pushes();
    expect(ps).toHaveLength(1);
    expect(ps[0]?.p).toEqual({ v: 1, type: 'resolve', user_id: UA, kind: 'todo', id: t.id, due_at: X });
    expect(w.f.requests.every((r) => !r.url.includes('apple'))).toBe(true);
    expect(w.db.tables.todos.get(t.id)?.pushed_for).toBeNull();
    await round(w.deps({ now: () => now + 60_000 }));
    expect(w.pushes()).toHaveLength(1);
    expect(w.db.beats.at(0)).toEqual({ claimed: 0, sent: 0, failed: 0, budget_hit: false });   // resolve 不计进提醒的四项
  });
  it('推过之后按了“稍后”：发 resolve 换掉旧通知，到了稍后的时刻照常再推', async () => {
    const w = await world({ [UA]: [fcm()] });
    const now = Date.now();
    const X = now - 60_000;
    const t = w.db.put('todos', todoRow(UA, { remind_at: X, pushed_for: X, snooze_at: now + 10 * 60_000 }));
    await round(w.deps({ now: () => now }));
    expect(w.pushes().map((x) => x.p['type'])).toEqual(['resolve']);
    await round(w.deps({ now: () => now + 10 * 60_000 }));
    expect(w.pushes().map((x) => [x.p['type'], x.p['due_at']])).toEqual([['resolve', X], ['remind', now + 10 * 60_000]]);
    expect(w.db.tables.todos.get(t.id)?.pushed_for).toBe(now + 10 * 60_000);
  });
});

describe('D3 第 6 点：不重复、最多一次', () => {
  it('两轮人为重叠：每条只发一次（每台设备各一条）', async () => {
    const w = await world({ [UA]: [fcm(), fcm()], [UB]: [fcm()] }, { delayMs: 30 });
    const now = Date.now();
    const ids = [];
    for (let i = 0; i < 15; i++) ids.push(w.db.put('todos', todoRow(i % 2 ? UA : UB, { remind_at: now - i })).id);
    const [a, b] = await Promise.all([round(w.deps({ now: () => now })), round(w.deps({ now: () => now }))]);
    expect((a?.claimed ?? 0) + (b?.claimed ?? 0)).toBe(15);
    const seen = w.pushes().map((x) => `${String(x.p['id'])}@${x.dev}`);
    expect(seen.length).toBe(new Set(seen).size);
    expect(seen).toHaveLength(7 * 2 + 8);   // UA 7 条 × 2 台，UB 8 条 × 1 台
  });
  it('认领后、发出前出错：这一条不再推；它还停在“错过的提醒”里（pushed_for = due_at，notified_for 没写）', async () => {
    const w = await world({ [UA]: [fcm()] });
    const now = Date.now();
    const boom = w.db.put('todos', todoRow(UA, { title: 'BOOM', remind_at: now }));
    const fine = w.db.put('todos', todoRow(UA, { title: 'ok', remind_at: now - 1 }));
    const logic = { ...LOGIC, notify: (i: Parameters<typeof LOGIC.notify>[0]) => { if (i.title === 'BOOM') throw new Error('x'); return LOGIC.notify(i); } };
    expect(await round(w.deps({ now: () => now, logic }))).toMatchObject({ claimed: 2, sent: 1, failed: 1 });
    expect(w.pushes().map((x) => x.p['id'])).toEqual([fine.id]);
    await round(w.deps({ now: () => now + 30_000 }));
    expect(w.pushes().map((x) => x.p['id'])).toEqual([fine.id]);
    const row = w.db.tables.todos.get(boom.id);
    expect(row?.pushed_for).toBe(now);
    expect(row?.notified_for).toBeNull();
    expect(row?.remind_at).toBe(now);
    expect(w.db.logs.find((l) => l.item_id === boom.id)?.code).toBe('build_failed');
  });
  it('预算（缩小版）：替身每个请求拖 300 毫秒、预算 1 秒，60 条：按时返回、budget_hit 对、left 是剩下的条数，下一轮接着发、每条只发一次', async () => {
    const users = Array.from({ length: 3 }, (_, i) => `${String(i + 1).repeat(8)}-0000-4000-8000-0000000000aa`);
    const w = await world(Object.fromEntries(users.map((u) => [u, [fcm()]])), { delayMs: 300 });
    const now = Date.now();
    for (let i = 0; i < 60; i++) w.db.put('todos', todoRow(users[i % 3] as string, { remind_at: now - 60_000 + i }));
    const t0 = Date.now();
    const r1 = await round(w.deps({ limits: { budgetMs: 1000 } }));
    expect(Date.now() - t0).toBeLessThan(1000 + 300 * 2 + 500);
    expect(r1.budget_hit).toBe(true);
    expect(r1.claimed).toBe(r1.sent);
    expect(r1.left).toBe(60 - r1.claimed);
    w.f.setDelay(0);
    let total = r1.claimed;
    for (let i = 0; i < 5 && total < 60; i++) total += (await round(w.deps())).claimed;
    expect(total).toBe(60);
    const ids = w.pushes().map((x) => x.p['id']);
    expect(new Set(ids).size).toBe(60);
    expect(ids).toHaveLength(60);
  });
  it('每轮发送条数上限：超过就停（budget_hit），剩下的下一轮', async () => {
    const w = await world({ [UA]: [fcm(), fcm()] });
    const now = Date.now();
    for (let i = 0; i < 10; i++) w.db.put('todos', todoRow(UA, { remind_at: now - i }));
    const r = await round(w.deps({ now: () => now, limits: { sendLimit: 7 } }));
    expect(r).toMatchObject({ claimed: 3, budget_hit: true, left: 7 });
    expect(w.f.requests).toHaveLength(6);
  });
});
