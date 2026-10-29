// 入口把设备行接进 report_tz（接手清单 K8-tz-device，架构 0.38 第 62 条④）：主页拿到锁后先登记或复用本会话的 devices 行，
// 登记好了用它的 id 和 platform 报时区；登记不上（断网）这次不报，之后用户操作、恢复网络时（过了重试间隔）补登记再报；
// 登记挂起期间放了锁、开始换账号：登记完成后不报
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coldStart, getBoot, resetBootForTest, type BootOptions } from '../../core/boot.ts';
import { createDeviceRegistrar, DEVICE_RETRY_MS } from '../../core/device-reg.ts';
import { clearAllCollections } from '../../core/store.ts';
import type { Sync } from '../../core/sync/engine.ts';
import { TZ_MIN_INTERVAL_MS } from '../../core/sync/report-tz.ts';
import { fakeLife, fakeTransport } from '../../core/sync/__tests__/fake-server.ts';
import { FakeDeviceServer } from '../../core/__tests__/device-fake.ts';
import { fakeIndexedDB } from '../../core/__tests__/idb-fake.ts';
import { wireSync } from '../sync-wiring.ts';

function bootOpts(): BootOptions {
  return {
    userId: 'A',
    appVersion: '4.0.0',
    cacheOptions: { factory: fakeIndexedDB().factory },
    listen426: false,
    clearCacheStorage: () => Promise.resolve(),
    upgradeDeps: { reload: () => undefined, swUpdate: () => Promise.resolve('no_update' as const), attempt: { get: () => null, set: () => undefined } },
  };
}

const idleSync = (): Sync =>
  ({ start: vi.fn(), stop: vi.fn(), drain: () => Promise.resolve(), subscribe: () => () => undefined, onEvent: () => () => undefined }) as unknown as Sync;

async function wire(platform: string, offline = false) {
  const boot = await coldStart(bootOpts());
  if (!boot.cache) throw new Error('cache');
  const server = new FakeDeviceServer();
  server.offline = offline;
  const t = fakeTransport();
  t.reportTz = (tz, id, p) => server.reportTz(tz, id, p);
  let clock = 1_000_000;
  const device = createDeviceRegistrar({
    transport: server, cache: boot.cache, platform, appVersion: '4.0.0',
    sessionId: () => server.session, installId: () => null, now: () => clock,
  });
  let activity: (() => void) | null = null;
  wireSync(boot, {
    transport: t,
    clearCacheStorage: () => Promise.resolve(),
    clearLocalSessionIf: () => undefined,
    goToAuth: () => undefined,
    setExitNotice: () => undefined,
    platform,
    deviceId: device.id,
    ensureDevice: device.ensure,
    create: () => idleSync(),
    onActivity: (fn) => {
      activity = fn;
      return () => {
        activity = null;
      };
    },
  });
  return { boot, server, device, act: () => activity?.(), tick: (ms: number) => (clock += ms) };
}

beforeEach(() => {
  clearAllCollections();
});
afterEach(() => {
  getBoot()?.cache?.close();
  resetBootForTest();
});

describe('设备行接进 report_tz（K8-tz-device）', () => {
  it('拿到锁：先登记本会话的设备行，再用它的 id 和 platform 报时区（服务器认得这一行，不回 device_mismatch）', async () => {
    const w = await wire('ios');
    await vi.waitFor(() => expect(w.server.tz).toHaveLength(1));
    const id = w.device.id();
    expect(id).not.toBeNull();
    expect(w.server.tz[0]).toMatchObject({ device: id, platform: 'ios' });
    expect(w.server.calls.indexOf('insert:devices')).toBeLessThan(w.server.calls.indexOf('report_tz'));
    expect(await w.boot.cache?.getMeta('device')).toMatchObject({ id, session: w.server.session, ok: true, ver: '4.0.0' });
  });

  it('断网登记不上：这次不报；联网后用户操作（过了重试间隔）补登记再报，只插一行', async () => {
    const w = await wire('web', true);
    await vi.waitFor(() => expect(w.server.calls).toContain('pull:devices'));
    await new Promise((r) => setTimeout(r, 0));
    expect(w.device.id()).toBeNull();
    expect(w.server.calls).not.toContain('report_tz');
    w.server.offline = false;
    w.act();   // 重试间隔内：不登记、不报
    await new Promise((r) => setTimeout(r, 0));
    expect(w.server.rows).toHaveLength(0);
    expect(w.server.tz).toHaveLength(0);
    w.tick(DEVICE_RETRY_MS);
    w.act();
    await vi.waitFor(() => expect(w.server.tz).toHaveLength(1));
    expect(w.server.rows).toHaveLength(1);
    expect(w.server.tz[0]).toMatchObject({ device: w.device.id(), platform: 'web' });
  });
});

describe('登记挂起期间的状态变化（K4 审查 2）、恢复网络（K4 审查 5）', () => {
  /** ensureDevice 挂起不返回，由测试放行；leader、lifecycle 都由测试控制 */
  async function pending() {
    const boot = await coldStart(bootOpts());
    const t = fakeTransport();
    const tz: string[] = [];
    t.reportTz = (zone, id) => {
      tz.push(id);
      return Promise.resolve({ ok: true, value: 'pending' as const });
    };
    let release: (id: string | null) => void = () => undefined;
    let id: string | null = null;
    const ensureDevice = vi.fn(
      () =>
        new Promise<string | null>((r) => {
          release = (v) => {
            id = v;
            r(v);
          };
        }),
    );
    let stop: (() => Promise<void>) | null = null;
    let leading = false;
    const life = fakeLife(true);
    wireSync(boot, {
      transport: t,
      clearCacheStorage: () => Promise.resolve(),
      clearLocalSessionIf: () => undefined,
      goToAuth: () => undefined,
      setExitNotice: () => undefined,
      platform: 'web',
      deviceId: () => id,
      ensureDevice,
      create: () => idleSync(),
      lifecycle: life,
      onActivity: () => () => undefined,
      leader: (o) => {
        stop = o.lead();
        leading = true;
        return {
          isLeader: () => leading,
          post: () => undefined,
          close: async () => {
            leading = false;
            await stop?.();
          },
        };
      },
    });
    const unlead = async (): Promise<void> => {
      leading = false;
      await stop?.();
    };
    return { boot, tz, ensureDevice, life, release: (v: string | null) => release(v), unlead };
  }

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
  };

  it('登记挂起期间放了锁：登记完成后不报时区', async () => {
    const p = await pending();
    expect(p.ensureDevice).toHaveBeenCalledTimes(1);
    await p.unlead();
    p.release('dev-1');
    await flush();
    expect(p.tz).toEqual([]);
  });

  it('登记挂起期间开始换账号（boot.switching）：登记完成后不报时区', async () => {
    const p = await pending();
    p.boot.switching = true;
    p.release('dev-1');
    await flush();
    expect(p.tz).toEqual([]);
  });

  it('对照：登记完成、仍是主页：报一次', async () => {
    const p = await pending();
    p.release('dev-1');
    await flush();
    expect(p.tz).toEqual(['dev-1']);
  });

  it('恢复网络（online）：再走一遍登记和报时区；放锁后不再听', async () => {
    const p = await pending();
    p.release(null);   // 第一次断网登记不上
    await flush();
    expect(p.tz).toEqual([]);
    p.life.goOnline();
    expect(p.ensureDevice).toHaveBeenCalledTimes(2);
    p.release('dev-1');
    await flush();
    expect(p.tz).toEqual(['dev-1']);
    await p.unlead();
    p.life.goOnline();
    expect(p.ensureDevice).toHaveBeenCalledTimes(2);
  });
});

describe('report_tz 回 rate_limited（接手清单 K8-tz-rl）', () => {
  it('不当失败（不记 report_tz_failed、不提示）、不马上重报；下一个上报时机（用户操作且过了 5 分钟）照常再报', async () => {
    const boot = await coldStart(bootOpts());
    const t = fakeTransport();
    const results: string[] = [];
    t.reportTz = () => {
      results.push('call');
      return Promise.resolve({ ok: true, value: 'rate_limited' as const });
    };
    const logs: string[] = [];
    let activity: (() => void) | null = null;
    let clock = 10_000_000;
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
    try {
      wireSync(boot, {
        transport: t, clearCacheStorage: () => Promise.resolve(), clearLocalSessionIf: () => undefined, goToAuth: () => undefined,
        setExitNotice: () => undefined, platform: 'ios', deviceId: () => 'dev-1', create: () => idleSync(), lifecycle: fakeLife(true),
        log: (act) => logs.push(act),
        onActivity: (fn) => {
          activity = fn;
          return () => undefined;
        },
      });
      await vi.waitFor(() => expect(results).toHaveLength(1));
      await new Promise((r) => setTimeout(r, 0));
      expect(results).toHaveLength(1);   // 不马上重报
      clock += TZ_MIN_INTERVAL_MS - 1;
      (activity as (() => void) | null)?.();
      await new Promise((r) => setTimeout(r, 0));
      expect(results).toHaveLength(1);   // 5 分钟内的操作：跳过
      clock += 1;
      (activity as (() => void) | null)?.();
      await vi.waitFor(() => expect(results).toHaveLength(2));
      expect(logs).not.toContain('report_tz_failed');
    } finally {
      spy.mockRestore();
    }
  });
});
