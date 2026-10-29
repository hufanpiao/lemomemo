// 多标签页选主（架构 4.3b、0.38 第 58 条）：两个页面只有一个是主页；主页关闭后排队的页面马上接手；主页隐藏时放手、前台页接手；
// 隐藏的页面不排队；没有 navigator.locks 时自己跑并记 sync_no_locks；提醒消息只转给别的页面
import { describe, expect, it } from 'vitest';
import { createTabLeader, type ChannelLike, type LocksLike, type SyncMessage, type TabLeader } from '../tab-leader.ts';
import { fakeBus, fakeLocks, fakeVisibility } from './tab-fakes.ts';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function page(locks: LocksLike | null, bus: (n: string) => ChannelLike, visible = true, listenOnly = false) {
  const vis = fakeVisibility(visible);
  const log: string[] = [];
  const msgs: SyncMessage[] = [];
  let leads = 0;
  let stops = 0;
  const leader: TabLeader = createTabLeader({
    name: 'lemo-sync:u1',
    lead: () => {
      leads++;
      return async () => {
        stops++;
      };
    },
    onMessage: (m) => msgs.push(m),
    log: (c) => log.push(c),
    locks,
    channel: bus,
    visibility: vis,
    ...(listenOnly ? { listenOnly: true } : {}),
  });
  return { leader, vis, log, msgs, leads: () => leads, stops: () => stops };
}

describe('选主（4.3b）', () => {
  it('两个页面只有一个是主页（只有它 lead）', async () => {
    const locks = fakeLocks();
    const bus = fakeBus();
    const a = page(locks, bus);
    const b = page(locks, bus);
    await flush();
    expect(a.leader.isLeader()).toBe(true);
    expect(b.leader.isLeader()).toBe(false);
    expect([a.leads(), b.leads()]).toEqual([1, 0]);
  });

  it('主页关闭：先 stop（等在途请求），放锁后排队的页面马上接手', async () => {
    const locks = fakeLocks();
    const bus = fakeBus();
    const a = page(locks, bus);
    const b = page(locks, bus);
    await flush();
    await a.leader.close();
    await flush();
    expect(a.stops()).toBe(1);
    expect(b.leader.isLeader()).toBe(true);
    expect(b.leads()).toBe(1);
  });

  it('主页隐藏时放手、前台页接手；隐藏的页面不排队，重新显示再排队', async () => {
    const locks = fakeLocks();
    const bus = fakeBus();
    const a = page(locks, bus);
    const b = page(locks, bus, false);   // 后台页：不排队
    await flush();
    expect(b.leads()).toBe(0);
    b.vis.set(true);
    a.vis.set(false);
    await flush();
    await flush();
    expect(a.leader.isLeader()).toBe(false);
    expect(a.stops()).toBe(1);
    expect(b.leader.isLeader()).toBe(true);
    a.vis.set(true);   // a 回到前台：排在 b 后面
    await flush();
    expect(a.leader.isLeader()).toBe(false);
    b.vis.set(false);
    await flush();
    await flush();
    expect(a.leader.isLeader()).toBe(true);
    expect(a.leads()).toBe(2);
  });

  it('没有 navigator.locks：自己当主页，记一次 sync_no_locks', () => {
    const p = page(null, fakeBus());
    expect(p.leader.isLeader()).toBe(true);
    expect(p.leads()).toBe(1);
    expect(p.log).toEqual(['sync_no_locks']);
  });

  it('提醒只转给别的页面；不认识的消息丢掉', async () => {
    const bus = fakeBus();
    const locks = fakeLocks();
    const a = page(locks, bus);
    const b = page(locks, bus);
    a.leader.post({ type: 'changed', colls: ['todos'] });
    b.leader.post({ type: 'outbox' });
    bus('x').postMessage({ type: 'evil' });
    await flush();
    expect(a.msgs).toEqual([{ type: 'outbox' }]);
    expect(b.msgs).toEqual([{ type: 'changed', colls: ['todos'] }]);
  });
});

describe('只听（listenOnly，TABLEADER-listen）', () => {
  it('有锁时不排队，可见性来回变也不排队；从不 lead、锁不在它手里；另一正常页照常拿锁、关闭后锁空着', async () => {
    const locks = fakeLocks();
    const bus = fakeBus();
    const l = page(locks, bus, true, true);   // 先建、可见：正常页会马上拿锁
    await flush();
    expect(locks.holder()).toBeNull();
    const b = page(locks, bus);
    await flush();
    expect(b.leader.isLeader()).toBe(true);
    expect(locks.holder()).toBe('w1');   // 只有 b 排过队
    l.vis.set(false);
    l.vis.set(true);
    await b.leader.close();
    await flush();
    await flush();
    expect(locks.holder()).toBeNull();
    expect(l.leader.isLeader()).toBe(false);
    expect([l.leads(), l.stops()]).toEqual([0, 0]);
    expect(l.log).toEqual([]);
  });

  it('收得到 reset（带 notice、sid）和 changed；它 post 的别的页面收得到', async () => {
    const locks = fakeLocks();
    const bus = fakeBus();
    const l = page(locks, bus, true, true);
    const b = page(locks, bus);
    await flush();
    b.leader.post({ type: 'reset', notice: 'pending_deletion', sid: 's1' });
    b.leader.post({ type: 'changed', colls: ['todos'] });
    l.leader.post({ type: 'outbox' });
    await flush();
    expect(l.msgs).toEqual([
      { type: 'reset', notice: 'pending_deletion', sid: 's1' },
      { type: 'changed', colls: ['todos'] },
    ]);
    expect(b.msgs).toEqual([{ type: 'outbox' }]);
  });

  it('没有 navigator.locks 也不当主页（D3）：isLeader false、不 lead、不记 sync_no_locks，照样收得到 reset', async () => {
    const bus = fakeBus();
    const l = page(null, bus, true, true);
    expect(l.leader.isLeader()).toBe(false);
    expect(l.leads()).toBe(0);
    expect(l.log).toEqual([]);
    bus('x').postMessage({ type: 'reset' });
    await flush();
    expect(l.msgs).toEqual([{ type: 'reset' }]);
  });

  it('close 后不再收；close 两次不抛、不 stop', async () => {
    const bus = fakeBus();
    const l = page(fakeLocks(), bus, true, true);
    await l.leader.close();
    await l.leader.close();
    bus('x').postMessage({ type: 'reset' });
    await flush();
    expect(l.msgs).toEqual([]);
    expect(l.stops()).toBe(0);
    expect(() => l.leader.post({ type: 'outbox' })).not.toThrow();
  });
});

describe('postSyncMessage（不选主时发一条提醒，R-256 ⑤）', () => {
  it('临时开频道发完就关；没有 BroadcastChannel、发送抛错都不抛', async () => {
    const { postSyncMessage, syncChannelName } = await import('../tab-leader.ts');
    const sent: unknown[] = [];
    let closed = 0;
    const names: string[] = [];
    postSyncMessage(syncChannelName('u1'), { type: 'reset' }, (name) => {
      names.push(name);
      return { postMessage: (m) => void sent.push(m), close: () => void closed++, onmessage: null };
    });
    expect(names).toEqual(['lemo-sync:u1']);
    expect(sent).toEqual([{ type: 'reset' }]);
    expect(closed).toBe(1);
    expect(() => postSyncMessage('x', { type: 'reset' }, () => null)).not.toThrow();
    expect(() =>
      postSyncMessage('x', { type: 'reset' }, () => ({
        postMessage: () => {
          throw new Error('closed');
        },
        close: () => void closed++,
        onmessage: null,
      })),
    ).not.toThrow();
    expect(closed).toBe(2);
  });
});

describe('reset 带退出原因（DISABLED-probe-later ②）', () => {
  it('带 notice、sid 的 reset 原样转给别的页面；类型不对的 notice、sid 去掉，当普通 reset', async () => {
    const locks = fakeLocks();
    const bus = fakeBus();
    const a = page(locks, bus);
    const b = page(locks, bus);
    await flush();
    a.leader.post({ type: 'reset', notice: 'pending_deletion', sid: 's1' });
    bus('lemo-sync:u1').postMessage({ type: 'reset', notice: 5, sid: 7 });
    await flush();
    expect(b.msgs).toContainEqual({ type: 'reset', notice: 'pending_deletion', sid: 's1' });
    expect(b.msgs).toContainEqual({ type: 'reset' });
  });
});
