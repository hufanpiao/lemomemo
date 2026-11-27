// 登记或复用本会话的 devices 行（core/device-reg.ts；架构 0.38 第 62 条④、0.29 续第 99、104 条；接手清单 K8-tz-device）
import { describe, expect, it } from 'vitest';
import { openCache } from '../cache.ts';
import { createDeviceRegistrar, DEVICE_RETRY_MS, DEVICE_TOUCH_MS, type DeviceRegDeps } from '../device-reg.ts';
import { FakeDeviceServer, ME, memMeta, S1, S2 } from './device-fake.ts';
import { fakeIndexedDB } from './idb-fake.ts';

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

describe('createDeviceRegistrar', () => {
  it('第一次：插一行（session_id 由服务器按本会话填），带 platform、install_id、app_version；meta 记 ok；之后不再联网', async () => {
    const { server, meta, reg } = setup();
    expect(reg.id()).toBeNull();
    const id = await reg.ensure();
    expect(id).not.toBeNull();
    expect(reg.id()).toBe(id);
    expect(server.mine()).toHaveLength(1);
    const row = server.mine()[0];
    expect(row).toMatchObject({ id, session_id: S1, platform: 'ios', install_id: INST, app_version: '4.0.0' });
    expect(row?.last_seen_at).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(meta.m.get('device')).toEqual({ id, session: S1, ok: true, seenAt: 1_000_000, ver: '4.0.0' });
    const before = server.calls.length;
    expect(await reg.ensure()).toBe(id);
    expect(server.calls.length).toBe(before);
  });

  it('重新打开页面（新的 registrar、同一个 meta）：直接用 meta 里的 id，离线也行，不联网', async () => {
    const a = setup();
    const id = await a.reg.ensure();
    a.server.offline = true;
    const before = a.server.calls.length;
    const reg2 = createDeviceRegistrar(a.deps);
    expect(await reg2.ensure()).toBe(id);
    expect(reg2.id()).toBe(id);
    expect(a.server.calls.length).toBe(before);
  });

  it('断网：返回 null、不抛；间隔内不重试，过了间隔用同一个 id 插，只有一行', async () => {
    const { server, meta, reg, tick } = setup();
    server.offline = true;
    expect(await reg.ensure()).toBeNull();
    expect(meta.m.get('device')).toBeUndefined();   // 连本会话的行都没拉到：还没选 id
    server.offline = false;
    tick(DEVICE_RETRY_MS - 1);
    expect(await reg.ensure()).toBeNull();   // 间隔内
    expect(server.rows).toHaveLength(0);
    tick(1);
    const id = await reg.ensure();
    expect(id).not.toBeNull();
    expect(server.rows).toHaveLength(1);
  });

  it('insert 写进去了但回包丢了：下次用同一个 id 重发（upsert 幂等），服务器只有一行', async () => {
    const { server, meta, reg, tick } = setup();
    server.dropNextReply = true;
    expect(await reg.ensure()).toBeNull();
    const pending = meta.m.get('device') as { id: string; ok: boolean };
    expect(pending.ok).toBe(false);
    tick(DEVICE_RETRY_MS);
    expect(await reg.ensure()).toBe(pending.id);
    expect(server.rows).toHaveLength(1);
    expect(meta.m.get('device')).toMatchObject({ id: pending.id, session: S1, ok: true });
  });

  it('重新验证邮箱后 rebind_device 把这一行交接给新会话（id 不变，第 104 条）：按会话找到同一行复用，不插新行', async () => {
    const a = setup();
    const id = await a.reg.ensure();
    const row = a.server.rows[0];
    if (!row) throw new Error('row');
    row.session_id = S2;
    a.server.session = S2;
    const reg2 = createDeviceRegistrar(a.deps);
    expect(await reg2.ensure()).toBe(id);
    expect(a.server.rows).toHaveLength(1);
    expect(a.meta.m.get('device')).toMatchObject({ id, session: S2, ok: true, ver: '4.0.0' });
    expect(a.server.patches).toHaveLength(1);   // 复用按会话找到的行：马上刷新一次 last_seen_at
  });

  it('meta 被清掉（本机库迁移失败）但服务器上有本会话的行：复用，不插第二行', async () => {
    const a = setup();
    const id = await a.reg.ensure();
    a.meta.m.clear();
    const reg2 = createDeviceRegistrar(a.deps);
    expect(await reg2.ensure()).toBe(id);
    expect(a.server.rows).toHaveLength(1);
  });

  it('不认领别的会话的行、软删除的行（第 99 条③）：插新行；meta 里记着旧会话的 id 也不用', async () => {
    const a = setup();
    const old = await a.reg.ensure();
    const first = a.server.rows[0];
    if (!first) throw new Error('row');
    a.server.rows.push({ ...first, id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', session_id: S2, deleted_at: 1 });
    a.server.session = S2;   // 退出后重新登录（正常会清库；这里故意留着旧 meta）
    const reg2 = createDeviceRegistrar(a.deps);
    const id = await reg2.ensure();
    expect(id).not.toBe(old);
    expect(id).not.toBe('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
    expect(a.server.mine().map((r) => r.id)).toEqual([id]);
    expect(a.meta.m.get('device')).toMatchObject({ id, session: S2, ok: true });
  });

  it('读不到本机会话：返回 null、不联网', async () => {
    const { server, reg } = setup({ sessionId: () => null });
    expect(await reg.ensure()).toBeNull();
    expect(server.calls).toEqual([]);
  });

  it('同时调两次只发一次请求', async () => {
    const { server, reg } = setup();
    const [a, b] = await Promise.all([reg.ensure(), reg.ensure()]);
    expect(a).toBe(b);
    expect(server.calls.filter((c) => c.startsWith('insert'))).toHaveLength(1);
  });

  it('会话已吊销（session_revoked）、库已关：返回 null、不抛', async () => {
    const r1 = setup();
    r1.server.revoked.add(S1);
    expect(await r1.reg.ensure()).toBeNull();
    expect(r1.server.rows).toHaveLength(0);
    const r2 = setup();
    r2.meta.closed = true;
    expect(await r2.reg.ensure()).toBeNull();
  });

  it('install_id 读不到（隐私模式）：这一列留空，照样登记', async () => {
    const { server, reg } = setup({ installId: () => null });
    expect(await reg.ensure()).not.toBeNull();
    expect(server.rows[0]?.install_id).toBeNull();
  });

  it('真的本机库：meta 的 device 键存得进、读得回', async () => {
    const opened = await openCache({ factory: fakeIndexedDB().factory });
    if (!opened.ok) throw new Error('open');
    const server = new FakeDeviceServer();
    const deps: DeviceRegDeps = {
      transport: server, cache: opened.cache, sessionId: () => S1, installId: () => INST, platform: 'web', appVersion: '4.0.0',
    };
    const id = await createDeviceRegistrar(deps).ensure();
    expect(await opened.cache.getMeta('device')).toMatchObject({ id, session: S1, ok: true });
    opened.cache.close();
  });

  it('insert_conflict（这个 id 被别人的行占了）：返回 null，meta 换成新 id、仍是 ok = false；过了 60 秒用新 id 插入成功', async () => {
    const { server, meta, reg, tick } = setup();
    // 第一次选的 id（newId 的第 1 个）已被别的账号占着
    server.rows.push({
      id: 'dddddddd-dddd-4ddd-8ddd-000000000001', user_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', session_id: S2, platform: 'web',
      install_id: null, app_version: null, last_seen_at: null, deleted_at: null, rev: 1,
    });
    expect(await reg.ensure()).toBeNull();
    const next = meta.m.get('device') as { id: string; session: string; ok: boolean };
    expect(next.id).not.toBe('dddddddd-dddd-4ddd-8ddd-000000000001');
    expect(next).toMatchObject({ session: S1, ok: false });
    tick(DEVICE_RETRY_MS - 1);
    expect(await reg.ensure()).toBeNull();
    tick(1);
    expect(await reg.ensure()).toBe(next.id);
    expect(server.mine().map((r) => r.id)).toEqual([next.id]);
    expect(meta.m.get('device')).toMatchObject({ id: next.id, ok: true });
  });

  it('刷新 last_seen_at、app_version：一天内不刷；满一天经 apply_patch 刷一次（base_rev 1、只两列），seenAt 记进 meta', async () => {
    const { server, meta, reg, tick } = setup();
    const id = await reg.ensure();
    tick(DEVICE_TOUCH_MS - 1);
    expect(await reg.ensure()).toBe(id);
    expect(server.patches).toHaveLength(0);
    tick(1);
    expect(await reg.ensure()).toBe(id);
    expect(server.patches).toHaveLength(1);
    const p = server.patches[0];
    expect(p).toMatchObject({ p_table: 'devices', p_id: id, p_base_rev: 1, p_own_revs: [] });
    expect(Object.keys(p?.p_patch ?? {}).sort()).toEqual(['app_version', 'last_seen_at']);
    const t = 1_000_000 + DEVICE_TOUCH_MS;
    expect(server.mine()[0]?.last_seen_at).toBe(new Date(t).toISOString());
    expect(meta.m.get('device')).toMatchObject({ id, seenAt: t, ver: '4.0.0' });
    expect(await reg.ensure()).toBe(id);
    expect(server.patches).toHaveLength(1);   // 刚刷过
  });

  it('App 升级了（meta 里的 ver 不同）：重新打开页面马上刷新 app_version，不等一天', async () => {
    const a = setup();
    await a.reg.ensure();
    const reg2 = createDeviceRegistrar({ ...a.deps, appVersion: '4.0.1' });
    await reg2.ensure();
    expect(a.server.mine()[0]?.app_version).toBe('4.0.1');
    expect(a.meta.m.get('device')).toMatchObject({ ver: '4.0.1' });
  });

  it('刷新失败（断网）：id 照常返回；60 秒内不再试，之后再试成功', async () => {
    const { server, reg, tick } = setup();
    const id = await reg.ensure();
    tick(DEVICE_TOUCH_MS);
    server.offline = true;
    expect(await reg.ensure()).toBe(id);
    expect(server.patches).toHaveLength(1);
    server.offline = false;
    tick(DEVICE_RETRY_MS - 1);
    expect(await reg.ensure()).toBe(id);
    expect(server.patches).toHaveLength(1);
    tick(1);
    expect(await reg.ensure()).toBe(id);
    expect(server.patches).toHaveLength(2);
    expect(reg.id()).toBe(id);
  });

  it('整段在 deps.lock 里跑（跨标签页互斥，K4 审查 4）', async () => {
    const order: string[] = [];
    const { server, reg } = setup({
      lock: async (fn) => {
        order.push('lock');
        const r = await fn();
        order.push('unlock');
        return r;
      },
    });
    await reg.ensure();
    expect(order).toEqual(['lock', 'unlock']);
    expect(server.rows).toHaveLength(1);
  });

  it('没有锁时的兜底：拉取期间别的页面已登记好（meta 里有本会话的 id），不再插第二行', async () => {
    const a = setup();
    const other = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const pull = a.server.pullRows.bind(a.server);
    a.server.pullRows = async (t, q) => {
      const r = await pull(t, q);
      // 拉取返回后、本页生成新 id 之前：另一页插好了行并记进 meta
      a.server.rows.push({ id: other, user_id: ME, session_id: S1, platform: 'ios', install_id: null, app_version: null, last_seen_at: null, deleted_at: null, rev: 1 });
      a.meta.m.set('device', { id: other, session: S1, ok: true, seenAt: 1_000_000, ver: '4.0.0' });
      return r;
    };
    expect(await a.reg.ensure()).toBe(other);
    expect(a.server.rows).toHaveLength(1);
    expect(a.server.calls.filter((c) => c.startsWith('insert'))).toHaveLength(0);
  });

  it('交接主页：别的标签页刚刷过（meta 里 seenAt 新），本页内存里的旧，锁里重读后不再刷', async () => {
    const a = setup();
    const id = await a.reg.ensure();
    const other = createDeviceRegistrar(a.deps);   // 另一个标签页，同一个 meta
    await other.ensure();
    a.tick(DEVICE_TOUCH_MS);
    expect(await other.ensure()).toBe(id);   // 另一页先当主页，刷了一次
    expect(a.server.patches).toHaveLength(1);
    expect(await a.reg.ensure()).toBe(id);   // 本页接手：内存里 seenAt 旧，但锁里重读 meta 后不到期
    expect(a.server.patches).toHaveLength(1);
  });

  it('新旧两个版本轮流当主页：旧版本只刷 last_seen_at，不把 app_version 改回旧的，meta 的 ver 也不回退；新版本马上刷', async () => {
    const a = setup({ appVersion: '4.1.0' });
    const id = await a.reg.ensure();
    const old = createDeviceRegistrar({ ...a.deps, appVersion: '4.0.9' });
    expect(await old.ensure()).toBe(id);
    expect(a.server.patches).toHaveLength(0);   // 旧版本不算“版本变了”
    a.tick(DEVICE_TOUCH_MS);
    await old.ensure();
    expect(a.server.patches).toHaveLength(1);
    expect(Object.keys(a.server.patches[0]?.p_patch ?? {})).toEqual(['last_seen_at']);
    expect(a.server.mine()[0]?.app_version).toBe('4.1.0');
    expect(a.meta.m.get('device')).toMatchObject({ ver: '4.1.0', seenAt: 1_000_000 + DEVICE_TOUCH_MS });
    const newer = createDeviceRegistrar({ ...a.deps, appVersion: '4.2.0-preview.1' });
    await newer.ensure();
    expect(a.server.patches).toHaveLength(2);
    expect(a.server.mine()[0]?.app_version).toBe('4.2.0-preview.1');
    expect(a.meta.m.get('device')).toMatchObject({ ver: '4.2.0-preview.1' });
  });

  it('刷新回 not_found（行被移除）/ gone（软删除）：清掉 meta 的 device、返回 null；60 秒内不重新登记，之后插新行', async () => {
    for (const how of ['not_found', 'gone'] as const) {
      const a = setup();
      const id = await a.reg.ensure();
      const row = a.server.rows[0];
      if (!row) throw new Error('row');
      if (how === 'gone') row.deleted_at = 1;
      else row.session_id = S2;   // 本会话看不到这一行了
      a.tick(DEVICE_TOUCH_MS);
      expect(await a.reg.ensure()).toBeNull();
      expect(a.meta.m.has('device')).toBe(false);
      expect(a.reg.id()).toBeNull();
      a.tick(DEVICE_RETRY_MS - 1);
      expect(await a.reg.ensure()).toBeNull();
      expect(a.server.patches).toHaveLength(1);   // 不在 60 秒里反复刷
      a.tick(1);
      const id2 = await a.reg.ensure();
      expect(id2).not.toBeNull();
      expect(id2).not.toBe(id);
      expect(a.server.mine().map((r) => r.id)).toEqual([id2]);
    }
  });
});
