// 升级本机库被挡住（blocked）：boot.ts 收到 blocked 后等 BLOCKED_PROMPT_DELAY_MS 仍没打开才提示“请关掉其他打开的柠檬记窗口”
// （TC-B1-48 真浏览器实测：配合升级的标签页先写草稿再关库期间，chromium、webkit 都会先报 1 次 blocked，马上提示会闪一下）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimCache } from '../account.ts';
import { openCache, VERSION_CLOSE_WAIT_MS } from '../cache.ts';
import { BLOCKED_PROMPT_DELAY_MS, coldStart, getBoot, resetBootForTest, type BootOptions } from '../boot.ts';
import { clearAllCollections } from '../store.ts';
import { fakeIndexedDB } from './idb-fake.ts';

function opts(factory: IDBFactory, over: Partial<BootOptions> = {}): BootOptions {
  return {
    userId: 'u1',
    appVersion: '4.0.0',
    now: () => 1_800_000_000_000,
    cacheOptions: { factory },
    upgradeDeps: { reload: vi.fn(), swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    ...over,
  };
}

beforeEach(() => {
  clearAllCollections();
});
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('升级本机库被挡住（blocked）：延迟 BLOCKED_PROMPT_DELAY_MS 才提示', () => {
  const V2 = { version: 2, migrations: [{ to: 2, up: () => undefined }] };

  /** 推进假的 setTimeout（每 50 ms 一步），中间让真的 setImmediate（假 IDB 的宏任务）跑几轮 */
  async function step(ms: number): Promise<void> {
    for (let t = 0; t < ms; t += 50) {
      await vi.advanceTimersByTimeAsync(Math.min(50, ms - t));
      for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
    }
  }

  /** 开始 coldStart，同步订阅它的 upgrade，记下 blocked 每次变成什么 */
  function startBoot(o: BootOptions): { p: Promise<Awaited<ReturnType<typeof coldStart>>>; history: boolean[] } {
    const p = coldStart(o);
    const up = getBoot()?.upgrade;
    if (!up) throw new Error('no_boot');
    const history: boolean[] = [];
    let last = up.getState().blocked;
    up.subscribe(() => {
      const b = up.getState().blocked;
      if (b !== last) history.push(b);
      last = b;
    });
    return { p, history };
  }

  /** 只报一次 blocked、之后由测试决定成功/出错/永远不结束的 open 请求 */
  function stubFactory(after?: (req: { error?: DOMException; onerror?: (ev: { preventDefault(): void }) => void }) => void): IDBFactory {
    return {
      open: () => {
        const req: Record<string, unknown> & { onblocked?: () => void } = {};
        setImmediate(() => {
          req.onblocked?.();
          after?.(req as never);
        });
        return req;
      },
    } as unknown as IDBFactory;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('常量：VERSION_CLOSE_WAIT_MS 加余量', () => {
    expect(BLOCKED_PROMPT_DELAY_MS).toBeGreaterThan(VERSION_CLOSE_WAIT_MS);
  });

  it('TC-B1-48 配合升级：别的标签页先写草稿再关库（1.9 秒），期间收到 1 次 blocked → 不出“请关掉其他窗口”提示，打开成功', async () => {
    const { factory } = fakeIndexedDB();
    const old = await openCache({ factory });
    if (!old.ok) throw new Error('open');
    await claimCache(old.cache, 'u1');
    old.cache.onBeforeVersionClose(() => new Promise<void>((r) => setTimeout(r, 1900)));
    const onBlocked = vi.fn();
    const { p, history } = startBoot(opts(factory, { cacheOptions: { factory, ...V2, onBlocked } }));
    await step(2000);
    const b = await p;
    await step(BLOCKED_PROMPT_DELAY_MS + 1000);
    expect(onBlocked).toHaveBeenCalledTimes(1);
    expect(b.status).toBe('ready');
    expect(old.cache.isClosed()).toBe(true);
    expect(history).toEqual([]);
    expect(b.upgrade.getState().blocked).toBe(false);
  });

  it('没配合的旧页一直占着库：到 BLOCKED_PROMPT_DELAY_MS 才提示；旧页关掉以后打开成功、提示收起', async () => {
    const { factory, fake } = fakeIndexedDB();
    const seeded = await openCache({ factory });
    if (!seeded.ok) throw new Error('open');
    await claimCache(seeded.cache, 'u1');
    seeded.cache.close();
    // 旧页：不设 onversionchange
    const oldReq = fake.open('planner-v4', 1);
    await step(50);
    const oldDb = oldReq.result as unknown as { close(): void };
    const { p, history } = startBoot(opts(factory, { cacheOptions: { factory, ...V2 } }));
    await step(BLOCKED_PROMPT_DELAY_MS - 100);
    expect(getBoot()?.upgrade.getState().blocked).toBe(false);
    await step(200);
    expect(getBoot()?.upgrade.getState().blocked).toBe(true);
    oldDb.close();
    await step(100);
    const b = await p;
    expect(b.status).toBe('ready');
    expect(history).toEqual([true, false]);
  });

  it('打开成功取消计时：旧页 1 秒后关掉，之后再等也不出提示', async () => {
    const { factory, fake } = fakeIndexedDB();
    const seeded = await openCache({ factory });
    if (!seeded.ok) throw new Error('open');
    await claimCache(seeded.cache, 'u1');
    seeded.cache.close();
    const oldReq = fake.open('planner-v4', 1);
    await step(50);
    const { p, history } = startBoot(opts(factory, { cacheOptions: { factory, ...V2 } }));
    await step(1000);
    (oldReq.result as unknown as { close(): void }).close();
    await step(100);
    expect((await p).status).toBe('ready');
    expect(vi.getTimerCount()).toBe(0);
    await step(BLOCKED_PROMPT_DELAY_MS * 2);
    expect(history).toEqual([]);
  });

  it('出错取消计时：blocked 之后 open 报错 → unavailable，之后再等也不出提示', async () => {
    const factory = stubFactory((req) => {
      setTimeout(() => {
        req.error = new DOMException('boom', 'UnknownError');
        req.onerror?.({ preventDefault: () => undefined });
      }, 1000);
    });
    const { p, history } = startBoot(opts(factory, { cacheOptions: { factory } }));
    await step(1100);
    const b = await p;
    expect(b.status).toBe('unavailable');
    expect(b.error).toBe('UnknownError');
    expect(vi.getTimerCount()).toBe(0);
    await step(BLOCKED_PROMPT_DELAY_MS * 2);
    expect(history).toEqual([]);
  });

  it('卸载（resetBootForTest、重新 coldStart）取消计时：open 一直挂着也不再出提示', async () => {
    const factory = stubFactory();
    const { history } = startBoot(opts(factory, { cacheOptions: { factory } }));
    await step(500);
    resetBootForTest();
    expect(vi.getTimerCount()).toBe(0);
    await step(BLOCKED_PROMPT_DELAY_MS * 2);
    expect(history).toEqual([]);

    const second = startBoot(opts(factory, { cacheOptions: { factory } }));
    await step(500);
    const third = startBoot(opts(factory, { cacheOptions: { factory } }));
    await step(BLOCKED_PROMPT_DELAY_MS - 100);
    expect(second.history).toEqual([]);
    expect(third.history).toEqual([]);
    await step(200);
    expect(second.history).toEqual([]);
    expect(third.history).toEqual([true]);
  });
});
