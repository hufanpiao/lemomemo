// 断线退路以 14.4 为准（前台每 30 秒拉、每 5 分钟重试 WebSocket、记 realtime_fallback / realtime_restore；0.38 第 58 条②）、
// 放手时 drain（4.3b：等在途请求写回后停下，不再排新活；超时后回包照常写回、新主页 start 时复位残留 inflight，K8 复审必改）、
// onChanged（主页广播 changed）。发出去过的项不合并、分批发送、patch_bad_args 记日志见 send-release.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clock, setup, todo, uid } from '../../__tests__/outbox-fixtures.ts';
import { clearAllCollections } from '../../store.ts';
import { createSync, type Sync, type SyncOptions } from '../engine.ts';
import { createRealtimeLink, POLL_INTERVAL_MS, WS_RETRY_MS } from '../realtime-link.ts';
import { sendAll } from '../send.ts';
import type { RealtimeHandlers } from '../types.ts';
import { bootOf, fakeLife, fakeTransport, FakeServer, identityParse } from './fake-server.ts';

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('断线退路（14.4）', () => {
  it('断了每 30 秒拉一次、每 5 分钟换新频道重订阅；切换记 realtime_fallback / realtime_restore', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const subs: RealtimeHandlers[] = [];
    let unsubs = 0;
    const logs: string[] = [];
    let pulls = 0;
    const link = createRealtimeLink({
      transport: {
        subscribe: (_t, h) => {
          subs.push(h);
          return () => {
            unsubs++;
          };
        },
      },
      tables: ['todos'],
      onRow: () => undefined,
      onTombstone: () => undefined,
      onStatus: () => undefined,
      pull: () => {
        pulls++;
      },
      firstUp: () => undefined,
      gated: () => false,
      log: (c) => logs.push(c),
    });
    link.connect();
    subs[0]?.onStatus('up');
    expect(logs).toEqual([]);
    subs[0]?.onStatus('down');
    expect(logs).toEqual(['realtime_fallback']);
    vi.advanceTimersByTime(POLL_INTERVAL_MS);
    expect(pulls).toBe(1);
    vi.advanceTimersByTime(WS_RETRY_MS - POLL_INTERVAL_MS);
    expect(subs).toHaveLength(2);   // 5 分钟：丢掉旧频道、重新订阅
    expect(unsubs).toBe(1);
    subs[0]?.onStatus('up');   // 旧频道的回调不理
    expect(logs).toEqual(['realtime_fallback']);
    const before = pulls;
    subs[1]?.onStatus('up');
    expect(logs).toEqual(['realtime_fallback', 'realtime_restore']);
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 3);
    expect(pulls).toBe(before + 1);   // 连上时补拉一次，之后不轮询
    link.disconnect();
  });
});

describe('断线判定（0.38 第 62 条③）', () => {
  function linkWithLog() {
    const subs: RealtimeHandlers[] = [];
    const logs: string[] = [];
    let pulls = 0;
    const link = createRealtimeLink({
      transport: { subscribe: (_t, h) => (subs.push(h), () => undefined) },
      tables: ['todos'],
      onRow: () => undefined,
      onTombstone: () => undefined,
      onStatus: () => undefined,
      pull: () => {
        pulls++;
      },
      firstUp: () => undefined,
      gated: () => false,
      log: (c) => logs.push(c),
    });
    return { link, subs, logs, pulls: () => pulls };
  }

  it('自己主动关频道（隐藏放锁、换账号、退出）引起的 CLOSED 不算断线：不切轮询、不记日志', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const l = linkWithLog();
    l.link.connect();
    l.subs[0]?.onStatus('up');
    l.link.disconnect();
    l.subs[0]?.onStatus('down');   // removeChannel 之后频道报 CLOSED
    vi.advanceTimersByTime(POLL_INTERVAL_MS * 4);
    expect(l.logs).toEqual([]);
    expect(l.pulls()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fallback / restore 只在状态变化时各记一次；切回以收到 SUBSCRIBED（up）为准', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const l = linkWithLog();
    l.link.connect();
    l.subs[0]?.onStatus('up');
    l.subs[0]?.onStatus('down');
    l.subs[0]?.onStatus('down');   // 连着报两次断：只记一次
    expect(l.logs).toEqual(['realtime_fallback']);
    vi.advanceTimersByTime(WS_RETRY_MS);   // 重订阅了，但还没收到 up：不算恢复
    expect(l.logs).toEqual(['realtime_fallback']);
    l.subs[1]?.onStatus('up');
    l.subs[1]?.onStatus('up');
    expect(l.logs).toEqual(['realtime_fallback', 'realtime_restore']);
    l.link.disconnect();
  });
});

const running: Sync[] = [];
async function device(over: Partial<SyncOptions> = {}) {
  const { cache, outbox } = await setup();
  const t = fakeTransport(new FakeServer());
  const sync = createSync(bootOf(cache, outbox), {
    transport: t, parseRows: identityParse, lifecycle: fakeLife(), now: () => clock.t, skipConfig: true, onRemoved: () => undefined, ...over,
  });
  running.push(sync);
  return { cache, outbox, t, sync };
}
afterEach(() => {
  for (const s of running.splice(0)) s.stop();
});

describe('放手（drain，4.3b）', () => {
  it('等正在发的那一项写回再停；之后不再排新活、不再发', async () => {
    const d = await device();
    await d.outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    let release: (() => void) | null = null;
    const orig = d.t.insertRow.bind(d.t);
    d.t.insertRow = async (table, data) => {
      await new Promise<void>((r) => (release = r));
      return orig(table, data);
    };
    d.sync.start();
    await vi.waitFor(() => expect(release).not.toBeNull());   // 请求已经在路上
    const drained = d.sync.drain(1000);
    (release as (() => void) | null)?.();
    await drained;
    expect(d.sync.getState().stopped).toBe(true);
    expect(d.outbox.getStatus().pending).toBe(0);   // 在途的那一项确认写回了
    await d.outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2) });
    await d.sync.sendNow();
    expect(d.t.calls.filter((c) => c.startsWith('insert:'))).toEqual([`insert:todos:${uid(1)}`]);
  });

  it('在途请求超过时限：不再等，停下（请求一直不回：这一项留在 inflight，下一个主页 start 时改回 pending）', async () => {
    const d = await device();
    await d.outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    let onWire = false;
    d.t.insertRow = () => {
      onWire = true;
      return new Promise(() => undefined);
    };
    d.sync.start();
    await vi.waitFor(() => expect(onWire).toBe(true));   // 请求已经在路上
    await d.sync.drain(20);
    expect(d.sync.getState().stopped).toBe(true);
    expect((await d.outbox.list())[0]?.state).toBe('inflight');
  });

  it('K8R-1 drain 超时后在途请求才回来：回包照常写回（ack）；新引擎能把队列发完（探针 P6）', async () => {
    const d = await device();
    await d.outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    let release: (() => void) | null = null;
    const orig = d.t.insertRow.bind(d.t);
    d.t.insertRow = async (table, data) => {
      if (!release) await new Promise<void>((r) => (release = r));   // 只卡第一次
      return orig(table, data);
    };
    d.sync.start();
    await vi.waitFor(() => expect(release).not.toBeNull());   // 请求已经在路上
    await d.sync.drain(10);   // 放手只等 10ms：超时
    expect(d.sync.getState().stopped).toBe(true);
    (release as (() => void) | null)?.();   // 在途请求这时才回来：只是放手、库没封存，照常 ack（K8 三审①）
    await vi.waitFor(async () => expect(await d.outbox.list()).toEqual([]));
    const s2 = createSync(bootOf(d.cache, d.outbox), {
      transport: d.t, parseRows: identityParse, lifecycle: fakeLife(), now: () => clock.t, skipConfig: true, onRemoved: () => undefined,
    });
    running.push(s2);
    s2.start();
    await d.outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2) });
    await s2.sendNow();
    await s2.idle();
    expect(await d.outbox.list()).toEqual([]);
    expect(d.t.server.table('todos').has(uid(1))).toBe(true);
    expect(d.t.server.table('todos').has(uid(2))).toBe(true);
  });

  it('K8R-2 上一个主页留下的 inflight（崩溃、请求一直不回）：新引擎 start 时改回 pending，按原 op_id 发完', async () => {
    const d = await device();
    await d.outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    const orig = d.t.insertRow.bind(d.t);
    let onWire = false;
    d.t.insertRow = () => {
      onWire = true;
      return new Promise(() => undefined);
    };
    d.sync.start();
    await vi.waitFor(() => expect(onWire).toBe(true));
    await d.sync.drain(20);
    expect((await d.outbox.list())[0]?.state).toBe('inflight');
    d.t.insertRow = orig;
    const s2 = createSync(bootOf(d.cache, d.outbox), {
      transport: d.t, parseRows: identityParse, lifecycle: fakeLife(), now: () => clock.t, skipConfig: true, onRemoved: () => undefined,
    });
    running.push(s2);
    s2.start();
    await s2.idle();
    await s2.sendNow();
    expect(await d.outbox.list()).toEqual([]);
    expect(d.t.server.table('todos').has(uid(1))).toBe(true);
  });

  it('K8R-3 封存（不是放手）时在途请求回来：照旧不写库，这一项留在 inflight 给下次启动 boot 复位', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    let gate = false;
    const orig = t.insertRow.bind(t);
    t.insertRow = async (table, data) => {
      gate = true;   // 请求在路上时设闸
      return orig(table, data);
    };
    const base = {
      outbox, transport: t, gated: () => gate, blocked: () => false, emit: () => undefined, removed: () => undefined, touched: () => undefined,
    };
    expect(await sendAll({ ...base, released: () => false })).toBe('stopped');
    expect((await outbox.list())[0]?.state).toBe('inflight');
  });

  it('K8R-3b 只是放手：回包已拿到照常 ack 再停；还没发出去的那一项只复位它自己（K8 三审①③）', async () => {
    const { outbox } = await setup();
    const t = fakeTransport();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2) });
    let gate = false;
    const orig = t.insertRow.bind(t);
    t.insertRow = async (table, data) => {
      gate = true;
      return orig(table, data);
    };
    const base = {
      outbox, transport: t, gated: () => gate, blocked: () => false, emit: () => undefined, removed: () => undefined, touched: () => undefined,
      released: () => true,
    };
    expect(await sendAll(base)).toBe('stopped');
    expect((await outbox.list()).map((i) => [i.id, i.state])).toEqual([[uid(2), 'pending']]);   // 第一项已 ack，第二项没动
    // next 回来以后才设闸：这一项没发，改回 pending、带 sent
    const realNext = outbox.next.bind(outbox);
    gate = false;
    const wrapped = {
      ...base,
      outbox: Object.assign(Object.create(outbox) as typeof outbox, {
        next: async () => {
          const item = await realNext();
          gate = true;
          return item;
        },
      }),
    };
    expect(await sendAll(wrapped)).toBe('stopped');
    expect((await outbox.list()).map((i) => [i.id, i.state, i.sent])).toEqual([[uid(2), 'pending', true]]);
  });

  it('K8R-3c resetInflight(opId) 只复位这一项；不给 opId 复位全部（K8 三审③）', async () => {
    const { outbox } = await setup();
    await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
    await outbox.enqueue({ table: 'todos', id: uid(2), op: 'insert', data: todo(2) });
    const a = await outbox.next();
    expect(a).not.toBeNull();
    await outbox.resetInflight('no-such-op');   // 别的项：不动
    expect((await outbox.list()).map((i) => i.state)).toEqual(['inflight', 'pending']);
    await outbox.resetInflight(a?.op_id);
    expect((await outbox.list()).map((i) => [i.state, i.sent])).toEqual([['pending', true], ['pending', undefined]]);
    await outbox.next();
    await outbox.resetInflight();
    expect((await outbox.list()).map((i) => i.state)).toEqual(['pending', 'pending']);
  });

  it('onChanged：一件活写过的表交出去（主页据此广播 changed）', async () => {
    const changed: string[][] = [];
    const d = await device({ onChanged: (t) => changed.push([...t]) });
    d.t.server.insert('todos', todo(1));
    d.sync.start();
    await d.sync.idle();
    expect(changed.flat()).toContain('todos');
  });
});
