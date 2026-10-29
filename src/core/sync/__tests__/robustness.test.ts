// K8 审查必改的回归：串行链看门狗和整段超时（必改 1）、闸（必改 3）、401 与刷新 TC-B1-88 ①～⑧（必改 4）、
// Realtime 频道名唯一（必改 5）、gone 后补拉、拉取遇 401 刷新一次、stop 后不泄漏定时器和监听
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clock, seed, setup, todo, uid } from '../../__tests__/outbox-fixtures.ts';
import { clearAllCollections } from '../../store.ts';
import { createSync, type Sync, type SyncOptions } from '../engine.ts';
import { createRunner } from '../runner.ts';
import { refreshFlow, sendAll, type SendDeps } from '../send.ts';
import { createSupabaseTransport, subscribeRealtime, timeoutSignal, toSessionCheck } from '../../../platform/supabase/sync-transport.ts';
import type { SessionCheck } from '../types.ts';
import { bootOf, fakeLife, fakeTransport, FakeServer, identityParse, type FakeTransport } from './fake-server.ts';

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

const running: Sync[] = [];
async function device(server = new FakeServer(), over: Partial<SyncOptions> = {}) {
  const { cache, outbox } = await setup();
  const t = fakeTransport(server);
  const life = fakeLife();
  const removed: string[] = [];
  const logs: string[] = [];
  const boot = bootOf(cache, outbox);
  const sync = createSync(boot, {
    transport: t, parseRows: identityParse, lifecycle: life, now: () => clock.t, skipConfig: true,
    onRemoved: (c) => removed.push(c), log: (c) => logs.push(c), ...over,
  });
  running.push(sync);
  return { cache, outbox, t, life, sync, boot, removed, logs };
}

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});
afterEach(() => {
  for (const s of running.splice(0)) s.stop();
  vi.useRealTimers();
});

describe('必改 1：串行链不会被永不返回的活卡死', () => {
  it('runner 看门狗：活永不返回，超时后放行下一件，记 sync_task_timeout', async () => {
    const logs: string[] = [];
    const r = createRunner(() => false, () => undefined, (c) => logs.push(c), 20);
    let ran = false;
    void r.run(() => never());
    await r.run(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(logs).toEqual(['sync_task_timeout']);
  });

  it('ensureSession 永不返回（审查探针 P1）：看门狗放行后 Realtime 来的行照样写进本机', async () => {
    const d = await device(new FakeServer(), { taskTimeoutMs: 30 });
    d.t.ensureSession = () => never<SessionCheck>();
    await d.outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    d.sync.start();
    const row = d.t.server.insert('todos', todo(5));
    d.t.handlers?.onRow('todos', { ...row });
    await d.sync.idle();
    expect(await d.cache.getRow('todos', uid(5))).toBeDefined();
    expect(d.logs).toContain('sync_task_timeout');
  });

  it('传输层整段包超时：client()、getSession、refreshSession、请求永不返回都按断网', async () => {
    const hung = createSupabaseTransport({ client: () => never(), timeoutMs: 20 });
    expect(await hung.ensureSession()).toBe('network');
    expect(await hung.refreshSession()).toBe('network');
    expect(await hung.pullRows('todos', { since: null, after: null, limit: 10 })).toEqual({ ok: false, error: { network: true } });

    const stuck = {
      auth: { getSession: () => never(), refreshSession: () => never() },
      from: () => ({ select: () => ({ order: () => ({ order: () => ({ limit: () => ({ abortSignal: () => never(), then: (res: (v: unknown) => unknown) => never().then(res) }) }) }) }) }),
    } as unknown as SupabaseClient;
    const t = createSupabaseTransport({ client: () => Promise.resolve(stuck), timeoutMs: 20 });
    expect(await t.ensureSession()).toBe('network');
    expect(await t.refreshSession()).toBe('network');
    expect((await t.pullRows('todos', { since: null, after: null, limit: 10 })).ok).toBe(false);
  });

  it('没有 AbortSignal.timeout（旧浏览器）：timeoutSignal 用 AbortController 也会超时', async () => {
    const orig = (AbortSignal as unknown as { timeout?: unknown }).timeout;
    (AbortSignal as unknown as { timeout?: unknown }).timeout = undefined;
    try {
      const s = timeoutSignal(10).signal;
      expect(s).toBeDefined();
      expect(s?.aborted).toBe(false);
      await tick(30);
      expect(s?.aborted).toBe(true);
      const done = timeoutSignal(10);   // 请求结束时 clear：兜底定时器清掉，不再 abort（K8 复审建议 2）
      done.clear();
      await tick(30);
      expect(done.signal?.aborted).toBe(false);
    } finally {
      (AbortSignal as unknown as { timeout?: unknown }).timeout = orig;
    }
  });
});

function deps(outbox: SendDeps['outbox'], t: FakeTransport, over: Partial<SendDeps> = {}) {
  const removedCodes: string[] = [];
  const touched: string[] = [];
  const logs: string[] = [];
  return {
    outbox, transport: t, gated: () => outbox.isSuspended(), blocked: () => false, emit: () => undefined,
    removed: (c: string) => removedCodes.push(c), touched: (tb: string) => touched.push(tb), log: (c: string) => logs.push(c),
    removedCodes, touchedTables: touched, logs, ...over,
  };
}

describe('必改 3：闸', () => {
  it('闸在 outbox.next() 期间设上（审查探针 P3）：请求不发', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    let gate = false;
    const ob = Object.create(outbox) as typeof outbox;
    ob.next = async () => {
      const i = await outbox.next();
      gate = true;
      return i;
    };
    expect(await sendAll(deps(ob, t, { gated: () => gate }))).toBe('stopped');
    expect(t.calls).toEqual([]);
  });

  it('闸在请求发出后、响应处理前设上：不写回', async () => {
    const { outbox, cache } = await setup();
    const t = fakeTransport();
    const row = t.server.insert('todos', todo(1));
    await seed(cache, 'todos', uid(1), todo(1), row.rev);
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'x' } });
    let gate = false;
    t.beforeReply = () => {
      gate = true;
    };
    expect(await sendAll(deps(outbox, t, { gated: () => gate }))).toBe('stopped');
    expect((await outbox.list())[0]?.state).toBe('inflight');
  });

  it('闸设上但还没轮到 halt，回到前台（审查探针 P5）：不订阅 Realtime，直接停下', async () => {
    const d = await device();
    d.sync.start();
    await d.sync.idle();
    d.life.setVisible(false);
    const subs = { n: 0 };
    const orig = d.t.subscribe;
    d.t.subscribe = (a, b) => {
      subs.n++;
      return orig(a, b);
    };
    d.boot.switching = true;
    d.life.setVisible(true);
    expect(subs.n).toBe(0);
    expect(d.sync.getState().stopped).toBe(true);
  });

  it('stop() 以后定时器、监听、Realtime 都清干净（审查探针 P4）', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const d = await device();
    d.sync.start();
    d.t.handlers?.onStatus('down');
    d.sync.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(d.life.listeners()).toBe(0);
    expect(d.t.handlers).toBeNull();
  });
});

describe('必改 4：刷新令牌 TC-B1-88 ①～⑧', () => {
  it('toSessionCheck 三类：①断网 ②503 ③429 → network；④⑤ 含码 ⑥ 403 含 session_revoked → removed；⑦⑧ 别的 4xx → failed', () => {
    expect(toSessionCheck({ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' })).toBe('network');
    expect(toSessionCheck({ status: 503, message: 'Service Unavailable' })).toBe('network');
    expect(toSessionCheck({ status: 429, code: 'over_request_rate_limit' })).toBe('network');
    expect(toSessionCheck({ status: 400, code: 'session_not_found' })).toBe('removed');
    expect(toSessionCheck({ status: 400, message: 'Invalid Refresh Token: refresh_token_not_found' })).toBe('removed');
    expect(toSessionCheck({ status: 403, message: 'session_revoked: device removed' })).toBe('removed');
    expect(toSessionCheck({ status: 400, message: 'session_revoked' })).toBe('failed');   // 不是 403 不算
    expect(toSessionCheck({ status: 400, code: 'refresh_token_already_used' })).toBe('failed');   // 不再直接当被移除
    expect(toSessionCheck({ status: 422, code: 'validation_failed' })).toBe('failed');
  });

  it('refreshFlow：⑦ 别的 4xx 记日志再试一次，成功不退出；⑧ 两次都失败按被移除', async () => {
    const logs: string[] = [];
    const seq = (xs: SessionCheck[]) => ({ refreshSession: () => Promise.resolve(xs.shift() ?? 'ok'), sessionId: () => 's1' });
    expect(await refreshFlow(seq(['failed', 'ok']), (c) => logs.push(c))).toEqual({ kind: 'ok' });
    expect(logs).toEqual(['auth_refresh_4xx']);
    expect(await refreshFlow(seq(['failed', 'failed']), (c) => logs.push(c))).toEqual({ kind: 'removed', code: 'auth_refresh_failed', sid: 's1' });
    expect(logs).toHaveLength(3);
  });

  const cases: { name: string; refresh: SessionCheck[]; out: string; removed: string[] }[] = [
    { name: '①②③ 临时故障', refresh: ['network'], out: 'retry', removed: [] },
    { name: '④⑤⑥ 被移除', refresh: ['removed'], out: 'removed', removed: ['session_not_found'] },
    { name: '⑦ 别的 4xx，第二次成功', refresh: ['failed', 'ok'], out: 'done', removed: [] },
    { name: '⑧ 别的 4xx，两次都失败', refresh: ['failed', 'failed'], out: 'removed', removed: ['auth_refresh_failed'] },
  ];
  for (const c of cases) {
    it(`sendAll 收到 401 后刷新：${c.name}`, async () => {
      const { outbox } = await setup();
      const t = fakeTransport();
      for (let n = 1; n <= 2; n++) await outbox.enqueue({ table: 'todos', id: uid(n), op: 'insert', data: todo(n) });
      t.failNext.push({ status: 401 });
      t.refresh.push(...c.refresh);
      const d = deps(outbox, t);
      expect(await sendAll(d)).toBe(c.out);
      expect(d.removedCodes).toEqual(c.removed);
      if (c.out === 'retry') {
        const items = await outbox.list();
        expect(items.map((i) => [i.state, i.tries])).toEqual([['pending', 0], ['pending', 0]]);   // 不计 tries、不退出
        t.refresh.push('ok');
        expect(await sendAll(d)).toBe('done');   // 稍后再试成功后发出
        expect(outbox.getStatus().pending).toBe(0);
      }
      if (c.out === 'done') expect(outbox.getStatus().pending).toBe(0);
    });
  }

  it('拉取遇到 401：刷新一次再拉；刷新回被移除走 onRemoved', async () => {
    const d = await device();
    d.t.server.insert('todos', todo(1));
    d.t.pullFailAt = { n: 1, failure: { status: 401, code: 'PGRST301' } };
    d.sync.start();
    await d.sync.idle();
    expect(await d.cache.getRow('todos', uid(1))).toBeDefined();
    expect(d.removed).toEqual([]);

    const e = await device();
    e.t.pullFailAt = { n: 1, failure: { status: 401 } };
    e.t.refresh.push('removed');
    e.sync.start();
    await e.sync.idle();
    expect(e.removed).toEqual(['session_not_found']);
    expect(e.sync.getState().stopped).toBe(true);
  });
});

describe('必改 5 和其他', () => {
  it('Realtime 频道名每次唯一（上一个 removeChannel 还没完成也不会拿到旧频道）', async () => {
    const names: string[] = [];
    const channel = { on: () => channel, subscribe: () => channel };
    const client = {
      channel: (n: string) => {
        names.push(n);
        return channel;
      },
      removeChannel: () => never(),
      realtime: { setAuth: () => Promise.resolve() },
    } as unknown as SupabaseClient;
    const h = { onRow: () => undefined, onTombstone: () => undefined, onStatus: () => undefined };
    const off = subscribeRealtime(() => Promise.resolve(client), ['todos'], h);
    await tick();
    off();
    subscribeRealtime(() => Promise.resolve(client), ['todos'], h);
    await tick();
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    expect(names[0]).toMatch(/^lemo-sync-\d+$/);
  });

  it('gone 之后补拉这张表；“发送失败”区的普通重试不重试 gone', async () => {
    const { cache, outbox } = await setup();
    const t = fakeTransport();
    const row = t.server.insert('todos', todo(1));
    await seed(cache, 'todos', uid(1), todo(1), row.rev);
    t.server.edit('todos', uid(1), { deleted_at: 123 });
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'patch', data: { title: 'x' } });
    const d = deps(outbox, t);
    expect(await sendAll(d)).toBe('done');
    expect(d.touchedTables).toEqual(['todos']);
    await outbox.retryFailed();
    expect((await outbox.list())[0]).toMatchObject({ state: 'failed', error: 'gone' });
  });
});
