// 冲突提示的队列（app/sync-notice-store.ts；K8 冲突提示方案 4.1、4.2、4.4，第五节 gate 的单测清单）
import { describe, expect, it, vi } from 'vitest';
import { NOTICE_TABLES } from '../../features/sync-notice/index.ts';
import { forkSuffixOf, isNoticeTable, titleOf } from '../sync-notice-store.ts';
import { conflict, flush, item, make } from './notice-store-fakes.ts';

describe('白名单（H2）', () => {
  it('五张表（index.ts 和 data/notice-tables.ts 两份一致由 features/sync-notice/__tests__/notice-tables.test.ts 查）', () => {
    expect([...NOTICE_TABLES]).toEqual(['events', 'todos', 'anniversaries', 'categories', 'notes']);
    expect(isNoticeTable('settings')).toBe(false);
    expect(isNoticeTable('note_images')).toBe(false);
  });

  it('名单外的冲突不出卡；名单外的 gone 走 drop、记 sync_gone_drop（只记 coll）', async () => {
    const { store, queue, calls, logs } = make();
    store.onSync(conflict({ table: 'settings', id: 's1' }));
    queue.push(item('devices', 'd1', { label: 'x' }));
    await store.readGone();
    await flush();
    expect(store.getState().queue).toEqual([]);
    expect(calls).toEqual([['devices', 'd1', 'drop']]);
    expect(logs).toEqual([['sync_gone_drop', { coll: 'devices' }]]);
  });
});

describe('gone 的收集（4.1）', () => {
  it('同一条记录的多项合成一张卡（H1）；标题先取修改里的，没有再读本机这一行；分类、纪念日取 name', async () => {
    const { store, queue } = make();
    queue.push(item('todos', 't1', { note: 'a' }), item('todos', 't1', { title: '  我的标题  ' }), item('categories', 'c1', { color: 2 }));
    queue.push(item('todos', 't2', { title: 'x' }, { state: 'pending', error: null }));
    await store.readGone();
    const q = store.getState().queue;
    expect(q.map((n) => n.key)).toEqual(['todos:t1', 'categories:c1']);
    expect(q[0]).toMatchObject({ kind: 'gone', title: '我的标题', status: 'idle' });
    expect(q[1]).toMatchObject({ title: '名c1' });
  });

  it('合并后 undone === true（M1）：不出卡，直接 drop，不记 sync_gone_drop', async () => {
    const { store, queue, calls, logs } = make();
    queue.push(item('todos', 't1', { title: 'x' }), item('todos', 't1', { undone: true }));
    await store.readGone();
    await flush();
    expect(store.getState().queue).toEqual([]);
    expect(calls).toEqual([['todos', 't1', 'drop']]);
    expect(logs).toEqual([]);
  });

  it('读的时候又来了通知：读完再读一遍（不漏）', async () => {
    let n = 0;
    const { store, queue } = make({ outbox: { list: async () => (n++, [...queue]) } });
    const a = store.readGone();
    queue.push(item('todos', 't1', { title: 'x' }));
    void store.readGone();
    await a;
    await flush();
    expect(n).toBe(2);
    expect(store.getState().queue).toHaveLength(1);
  });

  it('gone 事件也会重读', async () => {
    const { store, queue } = make();
    queue.push(item('todos', 't1', { title: 'x' }));
    store.onSync({ type: 'gone', table: 'todos', id: 't1', opId: 'op-1', data: {} });
    await flush();
    expect(store.getState().queue).toHaveLength(1);
  });
});

describe('冲突（3.1、4.1）', () => {
  it('同一条记录按列合并：conflicts 取并集，old 逐列取最新；标题读本机这一行', async () => {
    const { store } = make();
    store.onSync(conflict({ conflicts: ['note'], old: { note: '旧1' } }));
    store.onSync(conflict({ conflicts: ['note', 'title'], old: { note: '旧2', title: '另' } }));
    await flush();
    const q = store.getState().queue;
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ kind: 'conflict', conflicts: ['note', 'title'], old: { note: '旧2', title: '另' }, title: '行todos:t1' });
  });

  it('排队：冲突卡在前，gone 卡在后（gone 先到也一样）', async () => {
    const { store, queue } = make();
    queue.push(item('todos', 'g1', { title: 'g' }));
    await store.readGone();
    store.onSync(conflict({ id: 'c1' }));
    await flush();
    expect(store.getState().queue.map((n) => `${n.kind}:${n.id}`)).toEqual(['conflict:c1', 'gone:g1']);
  });

  it('知道了：dismiss 收起这一张', async () => {
    const { store } = make();
    store.onSync(conflict());
    await flush();
    store.dismiss('todos:t1');
    expect(store.getState().queue).toEqual([]);
  });
});

describe('卡上按钮的结果（4.2）', () => {
  async function withGone() {
    const m = make();
    m.queue.push(item('todos', 't1', { title: 'x' }));
    await m.store.readGone();
    return m;
  }

  it('restored：收起；之后同一记录的旧 gone 项还读得到（读和办同时）也不再出卡，读到不在了才清掉', async () => {
    const m = await withGone();
    m.reply({ ok: true, done: 'restored', opId: 'op-r' });
    m.store.restore('todos:t1');
    expect(m.store.getState().queue[0]).toMatchObject({ status: 'busy' });
    await flush();
    expect(m.store.getState().queue).toEqual([]);
    await m.store.readGone();
    expect(m.store.getState().queue).toEqual([]);
    expect(m.calls).toEqual([['todos', 't1', 'restore']]);
    // 同一条记录换了一批 gone（恢复后在途项又回 gone，旧的一批已删）：照常出卡（代码审查 K8 界面批 M2）
    m.queue.splice(0, m.queue.length, item('todos', 't1', { title: '又改了' }));
    await m.store.readGone();
    expect(m.store.getState().queue).toMatchObject([{ kind: 'gone', key: 'todos:t1', status: 'idle' }]);
  });

  it('resolveGone 回 nothing、gone 项还在：不记“已处理”，重读后卡回到 idle，可以再点（M2）', async () => {
    const m = await withGone();
    m.reply({ ok: true, done: 'nothing', opId: null });
    m.store.drop('todos:t1');
    await flush();
    expect(m.store.getState().queue).toMatchObject([{ key: 'todos:t1', status: 'idle' }]);   // flush 里已经重读过
  });

  it('local_unavailable、closing：卡留着换“没能恢复”（retry），可以再点', async () => {
    for (const reason of ['local_unavailable', 'closing'] as const) {
      const m = await withGone();
      m.reply({ ok: false, reason });
      m.store.restore('todos:t1');
      await flush();
      expect(m.store.getState().queue[0]).toMatchObject({ status: 'retry' });
      m.reply({ ok: true, done: 'dropped', opId: null });
      m.store.drop('todos:t1');
      await flush();
      expect(m.store.getState().queue).toEqual([]);
    }
  });

  it('resolveGone 抛错（分包下载不下来）：按临时失败处理', async () => {
    const m = make({ resolveGone: () => Promise.reject(new TypeError('Failed to fetch')) });
    m.queue.push(item('todos', 't1', { title: 'x' }));
    await m.store.readGone();
    m.store.restore('todos:t1');
    await flush();
    expect(m.store.getState().queue[0]).toMatchObject({ status: 'retry' });
  });

  it('switching：不提示，回到 idle', async () => {
    const m = await withGone();
    m.reply({ ok: false, reason: 'switching' });
    m.store.restore('todos:t1');
    await flush();
    expect(m.store.getState().queue[0]).toMatchObject({ status: 'idle' });
  });

  it('restore 被拒收（M8）：只剩“不用了”（blocked），记 sync_gone_restore_fail（coll、code）；再点恢复不调', async () => {
    const m = await withGone();
    m.reply({ ok: false, reason: 'rejected', code: 'readonly_row' });
    m.store.restore('todos:t1');
    await flush();
    expect(m.store.getState().queue[0]).toMatchObject({ status: 'blocked' });
    expect(m.logs).toEqual([['sync_gone_restore_fail', { coll: 'todos', code: 'readonly_row' }]]);
    m.store.restore('todos:t1');
    await flush();
    expect(m.calls).toHaveLength(1);
    m.reply({ ok: false, reason: 'local_unavailable' });
    m.store.drop('todos:t1');
    await flush();
    expect(m.store.getState().queue[0]).toMatchObject({ status: 'blocked' });
  });

  it('正在办时再点不重复调', async () => {
    const m = await withGone();
    m.store.restore('todos:t1');
    m.store.restore('todos:t1');
    m.store.drop('todos:t1');
    await flush();
    expect(m.calls).toHaveLength(1);
  });
});

describe('其余', () => {
  it('一个监听者抛错不挡后面的（L2）：错误放到微任务里再抛', async () => {
    const { store } = make();
    const thrown: unknown[] = [];
    const qm = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((fn) => {
      try {
        fn();
      } catch (e) {
        thrown.push(e);
      }
    });
    const after = vi.fn();
    store.subscribe(() => {
      throw new Error('boom');
    });
    store.subscribe(after);
    store.onSync(conflict());
    await flush();
    qm.mockRestore();
    expect(after).toHaveBeenCalled();
    expect(thrown).toHaveLength(1);
  });

  it('forked 说明的后缀按 profiles.ui_locale 取、trim 过；取不到为 null', () => {
    expect(forkSuffixOf({ profile: { ui_locale: 'ko-KR' } as never })).toBe('(충돌 사본)');
    expect(forkSuffixOf({ profile: { ui_locale: 'zh-CN' } as never })).toBe('（冲突副本）');
    expect(forkSuffixOf({ profile: null })).toBeNull();
  });

  it('titleOf：去掉首尾空白，空的、不是字符串的为 null', () => {
    expect(titleOf('todos', { title: ' a ' })).toBe('a');
    expect(titleOf('todos', { title: '   ' })).toBeNull();
    expect(titleOf('anniversaries', { name: '生日', title: 'x' })).toBe('生日');
    expect(titleOf('notes', null)).toBeNull();
  });

  it('close 以后：事件、读队列都不再出卡，不再通知', async () => {
    const { store, queue } = make();
    const fn = vi.fn();
    store.subscribe(fn);
    store.close();
    store.onSync(conflict());
    queue.push(item('todos', 't1', { title: 'x' }));
    await store.readGone();
    await flush();
    expect(store.getState().queue).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});
