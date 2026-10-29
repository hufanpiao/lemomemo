// 多标签页选主（架构 4.3b、0.38 第 58 条）：两个页面只有一个是主页；主页关闭后排队的页面马上接手；主页隐藏时放手、前台页接手；
// 隐藏的页面不排队；没有 navigator.locks 时自己跑并记 sync_no_locks；提醒消息只转给别的页面
import { describe, expect, it } from 'vitest';
import { createTabLeader, type ChannelLike, type LocksLike, type SyncMessage, type TabLeader } from '../tab-leader.ts';
import { fakeBus, fakeLocks, fakeVisibility } from './tab-fakes.ts';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function page(locks: LocksLike | null, bus: (n: string) => ChannelLike, visible = true) {
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
