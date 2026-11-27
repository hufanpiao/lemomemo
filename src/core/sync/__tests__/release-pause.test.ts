// 隐患 ②（11-10）：收到 426 暂停后，刚拉到的 app_config 显示本机版本已够 → 同版本恢复队列并发送；
// 配置仍高、配置读失败、min 为空或不合法 → 不恢复；config 来源的挡原有行为不变
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BootResult } from '../../boot.ts';
import { clock, setup, todo, uid } from '../../__tests__/outbox-fixtures.ts';
import { clearAllCollections } from '../../store.ts';
import { createUpgradeCenter } from '../../upgrade.ts';
import type { Lifecycle } from '../../../platform/net.ts';
import { createSync, type Sync } from '../engine.ts';
import { releaseUpgradePause } from '../round.ts';
import { fakeTransport, identityParse } from './fake-server.ts';

const upgradeCenter = () =>
  createUpgradeCenter({ appVersion: '4.0.0', reload: () => undefined, swUpdate: () => Promise.resolve('none' as never), attempt: { get: () => null, set: () => undefined } });

function bootOf(cache: BootResult['cache'], outbox: BootResult['outbox']): BootResult {
  return {
    status: 'ready', userId: uid(100), switching: false, cache, outbox, upgrade: upgradeCenter(), config: null, profile: null, flags: null,
    fullResync: [], refetch: {}, switchedUser: false, purged: 0, upgradeReport: null, outboxReport: null, error: null,
  };
}

function fakeLife(): Lifecycle & { setVisible(v: boolean): void } {
  const vis = new Set<(v: boolean) => void>();
  let isVis = true;
  return {
    onOnline: () => () => undefined,
    onVisibility: (f) => {
      vis.add(f);
      return () => void vis.delete(f);
    },
    isVisible: () => isVis,
    isOnline: () => true,
    setVisible(v) {
      isVis = v;
      vis.forEach((f) => f(v));
    },
  };
}

type Cfg = { ok: true; value: { config: Record<string, unknown> | null; profile: null } } | { ok: false; error: unknown };
const cfgOf = (min: unknown): Cfg => ({ ok: true, value: { config: { min_client_version: min }, profile: null } });

const running: Sync[] = [];
/** 一台设备：队列里 1 条，第一次发送撞 426（min 4.1.0），队列暂停、挡来源 426 */
async function pausedDevice(firstCfg: Cfg, source: '426' | 'queue' = '426') {
  const { cache, outbox } = await setup();
  const t = fakeTransport();
  let cfg = firstCfg;
  let cfgCalls = 0;
  t.fetchConfig = () => {
    cfgCalls++;
    return Promise.resolve(cfg as never);
  };
  const life = fakeLife();
  const boot = bootOf(cache, outbox);
  await outbox.enqueue({ table: 'todos', id: uid(1), op: 'insert', data: todo(1) });
  t.failNext.push({ status: 426, code: 'upgrade_required', min: '4.1.0' });
  const sync = createSync(boot, { transport: t, parseRows: identityParse, lifecycle: life, now: () => clock.t, onRemoved: () => undefined });
  running.push(sync);
  // 启动这一轮：先发（撞 426、写 outbox_pause）再拉配置；426 的挡由 main 那边接到事件后设，这里手动设
  sync.start();
  await sync.idle();
  boot.upgrade.reportUpgradeRequired('4.1.0', source);
  expect(outbox.getStatus().paused).toMatchObject({ min: '4.1.0', app: '4.0.0' });
  return {
    cache, outbox, t, life, sync, boot,
    setCfg: (c: Cfg) => (cfg = c),
    cfgCalls: () => cfgCalls,
    /** 切回前台：重拉配置 + 发送 */
    async foreground() {
      life.setVisible(false);
      life.setVisible(true);
      await sync.idle();
      await sync.idle();
    },
  };
}

beforeEach(() => {
  clearAllCollections();
  clock.t = 1_000_000;
});
afterEach(() => {
  running.splice(0).forEach((s) => s.stop());
});

describe('隐患 ② 426 暂停后同版本恢复', () => {
  it('426 来源：配置调低到本机版本 → 解除挡、删暂停、队列马上发出去', async () => {
    const d = await pausedDevice(cfgOf('4.1.0'));
    await d.foreground();
    expect(d.boot.upgrade.getState().syncBlocked).toMatchObject({ source: '426' });
    expect(d.t.server.table('todos').size).toBe(0);

    d.setCfg(cfgOf('4.0.0'));
    await d.foreground();
    expect(d.boot.upgrade.getState().syncBlocked).toBeNull();
    expect(await d.cache.getMeta('outbox_pause')).toBeUndefined();
    expect(d.outbox.getStatus()).toMatchObject({ pending: 0, paused: null });
    expect(d.t.server.table('todos').size).toBe(1);
  });

  it('queue 来源（重启后从暂停恢复的挡）：配置调低 → 同样恢复并发送', async () => {
    const d = await pausedDevice(cfgOf('4.1.0'), 'queue');
    d.setCfg(cfgOf('3.9.0'));
    await d.foreground();
    expect(d.boot.upgrade.getState().syncBlocked).toBeNull();
    expect(d.outbox.getStatus()).toMatchObject({ pending: 0, paused: null });
    expect(d.t.server.table('todos').size).toBe(1);
  });

  it('配置仍高 → 不恢复、不发', async () => {
    const d = await pausedDevice(cfgOf('4.1.0'));
    await d.foreground();
    expect(d.boot.upgrade.getState().syncBlocked).toMatchObject({ source: '426', min: '4.1.0' });
    expect(d.outbox.getStatus().paused).toMatchObject({ min: '4.1.0' });
    expect(d.t.server.table('todos').size).toBe(0);
  });

  it('配置读失败 → 不恢复', async () => {
    const d = await pausedDevice({ ok: false, error: { kind: 'network' } });
    await d.foreground();
    expect(d.boot.upgrade.getState().syncBlocked).toMatchObject({ source: '426' });
    expect(d.outbox.getStatus().paused).not.toBeNull();
    expect(d.t.server.table('todos').size).toBe(0);
  });

  it('min 为空、不合法、整个 config 为空 → 不恢复', async () => {
    for (const c of [cfgOf(null), cfgOf(''), cfgOf('abc'), { ok: true, value: { config: null, profile: null } } as Cfg]) {
      clearAllCollections();
      const d = await pausedDevice(c);
      await d.foreground();
      expect(d.boot.upgrade.getState().syncBlocked).toMatchObject({ source: '426' });
      expect(d.outbox.getStatus().paused).not.toBeNull();
      expect(d.t.server.table('todos').size).toBe(0);
    }
  });

  it('releaseUpgradePause 直接调：没暂停、没挡时什么也不做；预发布号不影响比较', async () => {
    const { cache, outbox } = await setup();
    const boot = bootOf(cache, outbox);
    await releaseUpgradePause(boot, '4.0.0', '4.0.0-preview.232');
    expect(boot.upgrade.getState().syncBlocked).toBeNull();

    boot.upgrade.reportUpgradeRequired('4.0.0', '426');
    await cache.setMeta('outbox_pause', { reason: 'upgrade', min: '4.0.0', app: '4.0.0-preview.232', at: 1 });
    await releaseUpgradePause(boot, '4.0.0', '4.0.0-preview.232');
    expect(boot.upgrade.getState().syncBlocked).toBeNull();
    expect(await cache.getMeta('outbox_pause')).toBeUndefined();
  });
});

describe('config 来源的挡：原有行为不变', () => {
  it('checkMinVersion 不带 all：配置调低只解除 config 来源，不解除 426 / queue 来源', () => {
    const u = upgradeCenter();
    u.checkMinVersion('4.1.0');
    expect(u.getState().syncBlocked).toEqual({ min: '4.1.0', source: 'config' });
    u.checkMinVersion('4.0.0');
    expect(u.getState().syncBlocked).toBeNull();
    u.checkMinVersion('4.1.0');
    u.checkMinVersion(null);
    expect(u.getState().syncBlocked).toBeNull();

    for (const source of ['426', 'queue'] as const) {
      const v = upgradeCenter();
      v.reportUpgradeRequired('4.1.0', source);
      v.checkMinVersion('4.0.0');
      v.checkMinVersion(null);
      expect(v.getState().syncBlocked).toMatchObject({ source });
    }
  });

  it('config 来源的挡、没有暂停：拉到调低的配置照常解除（走 applyFreshConfig），releaseUpgradePause 不碰队列', async () => {
    const { cache, outbox } = await setup();
    const boot = bootOf(cache, outbox);
    boot.upgrade.checkMinVersion('4.1.0');
    await releaseUpgradePause(boot, '4.1.0', '4.0.0');
    expect(boot.upgrade.getState().syncBlocked).toEqual({ min: '4.1.0', source: 'config' });
    await releaseUpgradePause(boot, '4.0.0', '4.0.0');
    expect(boot.upgrade.getState().syncBlocked).toEqual({ min: '4.1.0', source: 'config' });
  });
});

describe('代码审 aae88d16 建议', () => {
  it('S1 读 meta 出错、删暂停出错：当这次没解除，不抛，挡和暂停都还在', async () => {
    const { cache, outbox } = await setup();
    const boot = bootOf(cache, outbox);
    boot.upgrade.reportUpgradeRequired('4.1.0', '426');
    await cache.setMeta('outbox_pause', { reason: 'upgrade', min: '4.1.0', app: '4.0.0', at: 1 });

    const getMeta = cache.getMeta.bind(cache);
    cache.getMeta = (() => Promise.reject(new Error('idb'))) as typeof cache.getMeta;
    await expect(releaseUpgradePause(boot, '4.0.0', '4.0.0')).resolves.toBeUndefined();
    expect(boot.upgrade.getState().syncBlocked).toEqual({ min: '4.1.0', source: '426' });
    cache.getMeta = getMeta;

    outbox.resume = () => Promise.reject(new Error('idb'));
    await expect(releaseUpgradePause(boot, '4.0.0', '4.0.0')).resolves.toBeUndefined();
    expect(boot.upgrade.getState().syncBlocked).toEqual({ min: '4.1.0', source: '426' });
    expect(await cache.getMeta('outbox_pause')).toMatchObject({ min: '4.1.0' });
  });

  it('S1 引擎里删暂停出错：这一轮拉取照常完成（配置不再重拉），挡还在、不发', async () => {
    const d = await pausedDevice(cfgOf('4.1.0'));
    d.outbox.resume = () => Promise.reject(new Error('idb'));
    d.setCfg(cfgOf('4.0.0'));
    d.t.server.table('todos').set(uid(9), { ...todo(9), rev: 1 } as never);
    await d.foreground();
    expect(d.boot.upgrade.getState().syncBlocked).toMatchObject({ source: '426' });
    expect(d.outbox.getStatus().paused).not.toBeNull();
    expect(d.t.server.table('todos').size).toBe(1);   // 只有服务器自己那条，本机那条没发出去
    expect(await d.cache.getRow('todos', uid(9))).toBeDefined();   // 这一轮照常拉完：服务器那条拉到了本机
  });

  it('S2 解除后服务器又回 426：队列重新暂停，这一轮不再自动解除', async () => {
    const d = await pausedDevice(cfgOf('4.1.0'));
    d.setCfg(cfgOf('4.0.0'));
    d.t.failNext.push({ status: 426, code: 'upgrade_required', min: '4.1.0' });
    const before = d.cfgCalls();
    await d.foreground();
    expect(d.cfgCalls()).toBe(before + 1);
    expect(d.outbox.getStatus().paused).toMatchObject({ min: '4.1.0' });
    expect(await d.cache.getMeta('outbox_pause')).toMatchObject({ min: '4.1.0' });
    expect(d.t.server.table('todos').size).toBe(0);

    // 不切前台：再等几轮发送、拉取，都不重拉配置，也不解除
    const sends = d.t.calls.length;
    await d.sync.idle();
    await d.outbox.clearBackoff();
    await d.sync.idle();
    expect(d.cfgCalls()).toBe(before + 1);
    expect(d.outbox.getStatus().paused).toMatchObject({ min: '4.1.0' });
    expect(d.t.calls.length).toBe(sends);
    expect(d.t.server.table('todos').size).toBe(0);
  });
});
