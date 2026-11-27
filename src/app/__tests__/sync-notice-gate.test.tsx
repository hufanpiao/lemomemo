// 冲突提示的 gate（app/sync-notice-gate.ts；K8 冲突提示方案 2.1、2.2、4.1）：预建容器、读 gone 的四个时机、按需挂宿主、换账号卸掉、宿主出错
import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../../core/boot.ts';
import type { OutboxEvent, OutboxItem } from '../../core/outbox-types.ts';
import type { Sync } from '../../core/sync/engine.ts';
import type { SyncEvent, SyncState } from '../../core/sync/types.ts';
import type { SyncNoticeHostProps } from '../../features/sync-notice/index.ts';
import { startSyncNotices } from '../sync-notice-gate.ts';

const gone = (table: string, id: string, data: Record<string, unknown>): OutboxItem => ({
  op_id: `op-${id}`, table, id, rec: `${table}:${id}`, op: 'patch', data, base_rev: 1, own_revs: [], client_ts: 0, tries: 0, next_at: 0,
  state: 'failed', v: 1, app: '4.0.0', seq: 1, remind: false, deps: [], error: 'gone',
});

function fakes() {
  const queue: OutboxItem[] = [];
  const subs = new Set<() => void>();
  const outboxEvents = new Set<(e: OutboxEvent) => void>();
  const syncEvents = new Set<(e: SyncEvent) => void>();
  const syncSubs = new Set<() => void>();
  let state: SyncState = { syncing: false, realtime: 'down', lastPullAt: null, stopped: false };
  const list = vi.fn(async () => [...queue]);
  const outbox = {
    list,
    subscribe: (fn: () => void) => (subs.add(fn), () => void subs.delete(fn)),
    onEvent: (fn: (e: OutboxEvent) => void) => (outboxEvents.add(fn), () => void outboxEvents.delete(fn)),
  };
  const boot = {
    switching: false, profile: null, outbox,
    cache: { getRow: async () => ({ id: 'x', server: null, view: { title: '本机标题' } }) },
  } as unknown as BootResult;
  const sync: Pick<Sync, 'onEvent' | 'subscribe' | 'getState'> = {
    onEvent: (fn) => (syncEvents.add(fn), () => void syncEvents.delete(fn)),
    subscribe: (fn) => (syncSubs.add(fn), () => void syncSubs.delete(fn)),
    getState: () => state,
  };
  return {
    queue, list, boot, sync,
    notify: () => subs.forEach((f) => f()),
    emit: (e: SyncEvent) => syncEvents.forEach((f) => f(e)),
    stopSync: () => {
      state = { ...state, stopped: true };
      syncSubs.forEach((f) => f());
    },
    counts: () => [subs.size, outboxEvents.size, syncEvents.size, syncSubs.size],
  };
}

let seen: SyncNoticeHostProps | null = null;
function StubHost(p: SyncNoticeHostProps) {
  seen = p;
  return <p data-testid="stub">{p.store.getState().queue.length}</p>;
}
function Boom(): never {
  throw new Error('boom');
}

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 5; i++) await new Promise<void>((ok) => setTimeout(ok, 0));
  });
};

const stops: (() => void)[] = [];
afterEach(() => {
  act(() => stops.splice(0).forEach((s) => s()));
  seen = null;
  document.body.replaceChildren();
});

describe('sync-notice gate', () => {
  it('预建容器：body 末尾的 data-sync-notice role="region"，里面先放常驻的 role="status" aria-live="polite"；没东西时不挂宿主', async () => {
    const f = fakes();
    stops.push(startSyncNotices(f.sync, f.boot, { host: StubHost }));
    await flush();
    const region = document.body.lastElementChild;
    expect(region?.getAttribute('data-sync-notice')).toBe('');
    expect(region?.getAttribute('role')).toBe('region');
    const live = region?.firstElementChild;
    expect(live?.getAttribute('role')).toBe('status');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent).toBe('');
    expect(document.querySelector('[data-testid="stub"]')).toBeNull();
    expect(f.list).toHaveBeenCalledTimes(1);   // 启动时读一次
  });

  it('来了冲突：挂上宿主，props 里的 live、region 就是预建的那两个', async () => {
    const f = fakes();
    stops.push(startSyncNotices(f.sync, f.boot, { host: StubHost }));
    f.emit({ type: 'conflict', status: 'conflict', table: 'todos', id: 't1', conflicts: ['note'], old: null, forkId: null, opId: 'op-1' });
    await flush();
    expect(document.querySelector('[data-testid="stub"]')?.textContent).toBe('1');
    const region = document.querySelector('[data-sync-notice]');
    expect(seen?.region).toBe(region);
    expect(seen?.live).toBe(region?.firstElementChild);
    expect(seen?.store.getState().queue[0]).toMatchObject({ title: '本机标题' });
  });

  it('读 gone 的时机（L6）：启动、outbox.subscribe 通知、回到前台、gone 事件', async () => {
    const f = fakes();
    stops.push(startSyncNotices(f.sync, f.boot, { host: StubHost }));
    await flush();
    expect(f.list).toHaveBeenCalledTimes(1);
    f.notify();
    await flush();
    expect(f.list).toHaveBeenCalledTimes(2);
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(f.list).toHaveBeenCalledTimes(3);
    f.queue.push(gone('todos', 't1', { title: 'x' }));
    f.emit({ type: 'gone', table: 'todos', id: 't1', opId: 'op-t1', data: {} });
    await flush();
    expect(f.list).toHaveBeenCalledTimes(4);
    expect(document.querySelector('[data-testid="stub"]')?.textContent).toBe('1');
  });

  it('换账号（boot.switching）：下一次事件时卸掉宿主、移除容器、全部退订', async () => {
    const f = fakes();
    stops.push(startSyncNotices(f.sync, f.boot, { host: StubHost }));
    f.queue.push(gone('todos', 't1', { title: 'x' }));
    f.notify();
    await flush();
    expect(document.querySelector('[data-testid="stub"]')).not.toBeNull();
    (f.boot as { switching: boolean }).switching = true;
    act(() => f.notify());
    expect(document.querySelector('[data-sync-notice]')).toBeNull();
    expect(f.counts()).toEqual([0, 0, 0, 0]);
  });

  it('同步引擎 stopped（标签页隐藏放锁、drain）：不卸，回到前台照样读 gone、出卡（代码审查 K8 界面批 M1）', async () => {
    const f = fakes();
    stops.push(startSyncNotices(f.sync, f.boot, { host: StubHost }));
    await flush();
    act(() => f.stopSync());
    expect(document.querySelector('[data-sync-notice]')).not.toBeNull();
    f.queue.push(gone('todos', 't1', { title: 'x' }));
    document.dispatchEvent(new Event('visibilitychange'));
    await flush();
    expect(document.querySelector('[data-testid="stub"]')?.textContent).toBe('1');
    expect(f.counts().every((n) => n > 0)).toBe(true);
  });

  it('宿主出错（L3）：错误边界吞掉，记一条 js_error；页面其余不受影响', async () => {
    const f = fakes();
    const log = vi.fn();
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    stops.push(startSyncNotices(f.sync, f.boot, { host: Boom as never, log }));
    f.emit({ type: 'conflict', status: 'conflict', table: 'todos', id: 't1', conflicts: ['note'], old: null, forkId: null, opId: 'op-1' });
    await flush();
    err.mockRestore();
    expect(log).toHaveBeenCalledWith('js_error', { code: expect.stringContaining('Error') });
    expect(document.querySelector('[data-sync-notice]')).not.toBeNull();
  });

  it('订阅回调出错不往外冒（outbox.subscribe 在 enqueue 的 refresh 里同步调）：只记 js_error', async () => {
    const f = fakes();
    const log = vi.fn();
    stops.push(startSyncNotices(f.sync, f.boot, { host: StubHost, log }));
    await flush();
    Object.defineProperty(f.boot, 'switching', { get: () => { throw new Error('boom'); } });
    expect(() => f.notify()).not.toThrow();
    expect(() => f.emit({ type: 'gone', table: 'todos', id: 't1', opId: 'op-t1', data: {} })).not.toThrow();
    expect(log).toHaveBeenCalledWith('js_error', { code: expect.stringContaining('Error') });
  });

  it('没有本机库、outbox，或已经在换账号：什么都不做', () => {
    const f = fakes();
    stops.push(startSyncNotices(f.sync, { ...f.boot, outbox: null } as BootResult));
    stops.push(startSyncNotices(f.sync, { ...f.boot, switching: true } as BootResult));
    expect(document.querySelector('[data-sync-notice]')).toBeNull();
  });
});
