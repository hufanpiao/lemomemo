// 设备登记的日志 device_reg_failed（core/device-reg.ts；架构 0.38 第 67 条③、数据字典 4.6）：coll = devices、code = 服务器错误码或 http_<状态码>；
// 断网、库已关、读不到 session_id 不记；同一个页面同一个 code 只记一次；不放行 id、session_id、install_id 等
import { describe, expect, it } from 'vitest';
import { createDeviceRegistrar, DEVICE_RETRY_MS, type DeviceRegDeps } from '../device-reg.ts';
import { FakeDeviceServer, memMeta, S1, S2 } from './device-fake.ts';

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

describe('device_reg_failed', () => {
  it('device_reg_failed（0.38 第 67 条③）：insert 失败记 coll = devices、code = 错误码；同一个 code 只记一次；断网不记；不带 id、session、install_id', async () => {
    const logs: [string, unknown][] = [];
    const a = setup({ log: (act, f) => logs.push([act, f]) });
    a.server.offline = true;
    expect(await a.reg.ensure()).toBeNull();
    expect(logs).toEqual([]);   // 断网不记
    a.server.offline = false;
    a.server.revoked.add(S1);
    a.tick(DEVICE_RETRY_MS);
    expect(await a.reg.ensure()).toBeNull();
    a.tick(DEVICE_RETRY_MS);
    expect(await a.reg.ensure()).toBeNull();
    expect(logs).toEqual([['device_reg_failed', { coll: 'devices', code: 'session_revoked' }]]);
    expect(JSON.stringify(logs)).not.toContain(S1);
  });

  it('device_reg_failed：找本会话那一行时拉取失败（非断网）记 http_<状态码>；insert_conflict 也记', async () => {
    const logs: [string, unknown][] = [];
    const a = setup({ log: (act, f) => logs.push([act, f]) });
    const pull = a.server.pullRows.bind(a.server);
    let fail = true;
    a.server.pullRows = async (t, q) => (fail ? { ok: false, error: { status: 500 } } : pull(t, q));
    expect(await a.reg.ensure()).toBeNull();
    fail = false;
    a.server.rows.push({
      id: 'dddddddd-dddd-4ddd-8ddd-000000000001', user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', session_id: S2, platform: 'web',
      install_id: null, app_version: null, last_seen_at: null, deleted_at: null, rev: 1,
    });
    a.tick(DEVICE_RETRY_MS);
    expect(await a.reg.ensure()).toBeNull();
    expect(logs).toEqual([
      ['device_reg_failed', { coll: 'devices', code: 'http_500' }],
      ['device_reg_failed', { coll: 'devices', code: 'insert_conflict' }],
    ]);
  });

  it('读不到 session_id、库已关：不记', async () => {
    const logs: string[] = [];
    const a = setup({ sessionId: () => null, log: (act) => logs.push(act) });
    await a.reg.ensure();
    const b = setup({ log: (act) => logs.push(act) });
    b.meta.closed = true;
    await b.reg.ensure();
    expect(logs).toEqual([]);
  });
});
