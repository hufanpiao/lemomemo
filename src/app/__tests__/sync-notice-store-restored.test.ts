// 冲突提示队列：刚恢复的那一项（app/sync-notice-store.ts；K8 冲突提示方案 4.4，按 opId 认）。11-05 从 sync-notice-store.test.ts 拆出（超过 300 行）
import { describe, expect, it, vi } from 'vitest';
import { conflict, flush, item, make } from './notice-store-fakes.ts';

describe('刚恢复的那一项（4.4，按 opId 认）', () => {
  async function restored(opId = 'op-r') {
    const m = make();
    m.queue.push(item('notes', 'n1', { title: 'x' }));
    await m.store.readGone();
    m.reply({ ok: true, done: 'restored', opId });
    m.store.restore('notes:n1');
    await flush();
    m.queue.length = 0;
    m.queue.push(item('notes', 'n1', { title: 'x', deleted_at: null }, { op_id: opId, state: 'pending', error: null }));
    return m;
  }

  it('回 conflict：去掉 deleted_at、undone，剩下为空不出卡；还有别的列照常出卡（只列真冲突的列）', async () => {
    const m = await restored();
    m.store.onSync(conflict({ table: 'notes', id: 'n1', opId: 'op-r', conflicts: ['deleted_at', 'undone'] }));
    await flush();
    expect(m.store.getState().queue).toEqual([]);
    m.store.onSync(conflict({ table: 'notes', id: 'n1', opId: 'op-r', conflicts: ['deleted_at', 'tags'] }));
    await flush();
    expect(m.store.getState().queue[0]).toMatchObject({ kind: 'conflict', conflicts: ['tags'] });
  });

  it('随手记回 forked（P1）：不出卡；不是刚恢复的 forked 照常出卡', async () => {
    const m = await restored();
    m.store.onSync(conflict({ table: 'notes', id: 'n1', opId: 'op-r', status: 'forked', conflicts: ['title', 'deleted_at'], forkId: 'f1' }));
    await flush();
    expect(m.store.getState().queue).toEqual([]);
    m.store.onSync(conflict({ table: 'notes', id: 'n2', opId: 'op-other', status: 'forked', conflicts: ['title'], forkId: 'f2' }));
    await flush();
    expect(m.store.getState().queue[0]).toMatchObject({ status: 'forked', forkId: 'f2' });
  });

  it('rejected / not_found（P2）：出一次轻提示（hardDeleted 加 1）；不是刚恢复的、别的码不提示', async () => {
    const m = await restored();
    const it0 = item('notes', 'n1', {}, { op_id: 'op-r' });
    m.store.onOutbox({ type: 'rejected', item: item('notes', 'n9', {}, { op_id: 'op-other' }), code: 'not_found' });
    m.store.onOutbox({ type: 'rejected', item: it0, code: 'vault_required' });
    expect(m.store.getState().hardDeleted).toBe(0);
    m.store.onOutbox({ type: 'rejected', item: it0, code: 'not_found' });
    expect(m.store.getState().hardDeleted).toBe(1);
    expect(m.store.getState().queue).toEqual([]);
  });

  it('rejected / purged（墓碑删掉了本机没发出去的修改，第三方审查第 8 条）：不用是刚恢复的，也出一次轻提示', () => {
    const m = make();
    m.store.onOutbox({ type: 'rejected', item: item('todos', 't1', {}, { op_id: 'op-x' }), code: 'purged' });
    expect(m.store.getState().hardDeleted).toBe(1);
  });

  it('离线超过 5 分钟才发出去（复审四 L1）：只要恢复项还在队列里就一直认得', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const m = await restored();
      vi.setSystemTime(Date.now() + 30 * 60_000);
      for (let i = 0; i < 5; i++) await m.store.readGone();   // 离线期间读了很多次，恢复项一直在
      m.store.onSync(conflict({ table: 'notes', id: 'n1', opId: 'op-r', conflicts: ['deleted_at'] }));
      m.store.onSync(conflict({ table: 'notes', id: 'n1', opId: 'op-r', status: 'forked', conflicts: ['title'], forkId: 'f1' }));
      await flush();
      expect(m.store.getState().queue).toEqual([]);
      m.store.onOutbox({ type: 'rejected', item: item('notes', 'n1', {}, { op_id: 'op-r' }), code: 'not_found' });
      expect(m.store.getState().hardDeleted).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('确认以后（连续两次读队列都不在）不再认；只缺一次还认', async () => {
    const m = await restored();
    m.queue.length = 0;
    await m.store.readGone();
    m.store.onSync(conflict({ table: 'notes', id: 'n1', opId: 'op-r', conflicts: ['deleted_at'] }));
    await flush();
    expect(m.store.getState().queue).toEqual([]);   // 只缺了一次：还认
    await m.store.readGone();
    m.store.onSync(conflict({ table: 'notes', id: 'n1', opId: 'op-r', conflicts: ['deleted_at'] }));
    await flush();
    expect(m.store.getState().queue[0]).toMatchObject({ conflicts: ['deleted_at'] });   // 不再认：照常出卡
  });
});
