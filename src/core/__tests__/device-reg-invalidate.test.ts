// 设备行不在时忘掉缓存的 id（core/device-reg.ts 的 invalidate；push-claim 收到 device_not_found 时用）。搭建同 device-reg.test.ts
// 原注释：登记或复用本会话的 devices 行（core/device-reg.ts；架构 0.38 第 62 条④、0.29 续第 99、104 条；接手清单 K8-tz-device）
import { describe, expect, it } from 'vitest';
import { createDeviceRegistrar, type DeviceRegDeps } from '../device-reg.ts';
import { FakeDeviceServer, memMeta } from './device-fake.ts';

const INST = '33333333-3333-4333-8333-333333333333';

function setup(over: Partial<DeviceRegDeps> = {}) {
  const server = new FakeDeviceServer();
  const meta = memMeta();
  let t = 1_000_000;
  let n = 0;
  const deps: DeviceRegDeps = {
    transport: server,
    cache: meta as unknown as DeviceRegDeps['cache'],
    sessionId: () => server.session,
    installId: () => INST,
    platform: 'ios',
    appVersion: '4.0.0',
    newId: () => `dddddddd-dddd-4ddd-8ddd-${String(++n).padStart(12, '0')}`,
    now: () => t,
    ...over,
  };
  return { server, meta, deps, reg: createDeviceRegistrar(deps), tick: (ms: number) => (t += ms) };
}

describe('DeviceRegistrar.invalidate', () => {
  it('invalidate（服务器说设备行不在）：清掉 meta、内存和重试间隔，接着重新登记；之后 ensure 直接拿到新 id', async () => {
    const a = setup();
    const id = await a.reg.ensure();
    if (!id) throw new Error('id');
    a.server.rows = [];   // 服务器那一行被清理了
    await a.reg.invalidate(id);
    expect(a.meta.m.get('device')).not.toMatchObject({ id });
    const id2 = await a.reg.ensure();
    expect(a.reg.id()).toBe(id2);
    expect(id2).not.toBeNull();
    expect(id2).not.toBe(id);
    expect(a.server.mine().map((r) => r.id)).toEqual([id2]);
    expect(a.meta.m.get('device')).toMatchObject({ id: id2, ok: true });
  });

  it('invalidate 传的不是现在记的 id（别的标签页刚重登记过）：什么都不动', async () => {
    const a = setup();
    const id = await a.reg.ensure();
    const before = a.server.calls.length;
    await a.reg.invalidate('dddddddd-dddd-4ddd-8ddd-999999999999');
    expect(a.reg.id()).toBe(id);
    expect(a.meta.m.get('device')).toMatchObject({ id });
    expect(await a.reg.ensure()).toBe(id);
    expect(a.server.calls.length).toBe(before);
  });

  it('并发（代码审查建议 1）：invalidate 一开头同步忘掉内存里的旧 id；同时调的 ensure 等它重新登记，拿到的是新 id，不是旧的', async () => {
    const a = setup();
    const id = await a.reg.ensure();
    if (!id) throw new Error('id');
    a.server.rows = [];
    const inv = a.reg.invalidate(id);
    expect(a.reg.id()).toBeNull();
    const concurrent = a.reg.ensure();
    await inv;
    const id2 = await concurrent;
    expect(id2).not.toBeNull();
    expect(id2).not.toBe(id);
    expect(a.reg.id()).toBe(id2);
    expect(a.server.mine().map((r) => r.id)).toEqual([id2]);
  });

  it('id 对不上时不解除 60 秒节流：刚登记失败、间隔内 invalidate 别的 id，ensure 仍按节流返回 null、不联网', async () => {
    const a = setup();
    a.server.offline = true;
    expect(await a.reg.ensure()).toBeNull();
    const before = a.server.calls.length;
    a.server.offline = false;
    await a.reg.invalidate('dddddddd-dddd-4ddd-8ddd-999999999999');
    expect(await a.reg.ensure()).toBeNull();
    expect(a.server.calls.length).toBe(before);
  });
});

