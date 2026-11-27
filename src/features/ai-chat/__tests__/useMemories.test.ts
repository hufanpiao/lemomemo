// “记住的事”的状态和语音提问回包归类（R-495）
import { describe, expect, it, vi } from 'vitest';
import type { MemoryItem } from '../../../../shared/schema/ai-memory.ts';
import { voiceAskOf } from '../data/voice-ask.ts';
import { createMemories, type MemDeps } from '../hooks/useMemories.ts';

const A: MemoryItem = { id: '73000000-0000-4000-8000-0000000000a1', text: '对花生过敏，推荐吃的要避开', at: 1 };
const B: MemoryItem = { id: '73000000-0000-4000-8000-0000000000a2', text: '周报每周五交给产品组', at: 2 };

const page = (items: MemoryItem[], next: string | null = null, total = items.length) => ({ items, next, total });
const CUR = `9.${B.id}`;
const C: MemoryItem = { id: '73000000-0000-4000-8000-0000000000a3', text: '喜欢拉面', at: 3 };

function mk(change: MemDeps['change'] = async () => true, list: MemDeps['list'] = async () => page([A, B])) {
  const d = { list: vi.fn(list), change: vi.fn(change) };
  return { m: createMemories(d), d };
}

describe('useMemories', () => {
  it('读列表；读不到标失败', async () => {
    const { m } = mk();
    await m.load();
    expect(m.get().items).toEqual([A, B]);
    const bad = mk(undefined, async () => null);
    await bad.m.load();
    expect(bad.m.get()).toMatchObject({ items: null, failed: true });
  });
  it('删：服务器成了才拿掉，出撤销条；撤销后放回', async () => {
    const { m, d } = mk();
    await m.load();
    await m.remove(A.id, A.text, true);
    expect(m.get().items).toEqual([B]);
    expect(m.get().gone.has(A.id)).toBe(true);
    expect(m.get().toast).toEqual({ k: 'deleted', id: A.id, text: A.text, full: true });
    await m.undo(A.id);
    expect(d.change).toHaveBeenLastCalledWith({ action: 'undo', id: A.id }, expect.anything());
    expect(m.get().gone.has(A.id)).toBe(false);
    expect(m.get().items).toEqual([A, B]);
  });
  it('撤销改写：带旧行 id 发给服务器，提示条记下已改回，列表重读', async () => {
    const { m, d } = mk();
    await m.load();
    d.list.mockClear();
    await m.undoReplace(C.id, A.id);
    expect(d.change).toHaveBeenLastCalledWith({ action: 'undo', id: C.id, replaced: A.id }, expect.anything());
    expect(m.get().gone.has(C.id)).toBe(true);
    expect(m.get().reverted.has(C.id)).toBe(true);
    expect(d.list).toHaveBeenCalledTimes(1);
  });
  it('撤销改写失败：不算改回，提示失败', async () => {
    const { m } = mk(async () => false);
    await m.load();
    await m.undoReplace(C.id, A.id);
    expect(m.get().reverted.has(C.id)).toBe(false);
    expect(m.get().toast).toEqual({ k: 'failed' });
  });
  it('重读失败：旧列表留着，标失败给“重试”', async () => {
    let ok = true;
    const { m } = mk(undefined, async () => (ok ? page([A, B]) : null));
    await m.load();
    ok = false;
    await m.load();
    expect(m.get()).toMatchObject({ items: [A, B], failed: true });
  });
  it('关页：取消在路上的读请求，晚到的结果不要；写操作不跟着取消', async () => {
    let seen: AbortSignal | undefined;
    let finish: (v: ReturnType<typeof page>) => void = () => undefined;
    const { m, d } = mk(undefined, (s) => {
      seen = s;
      return new Promise((res) => { finish = res; });
    });
    const p = m.load();
    m.cancelReads();
    expect(seen?.aborted).toBe(true);
    finish(page([A]));
    await p;
    expect(m.get().items).toBeNull();
    await m.remove(A.id, A.text, false);
    expect(d.change.mock.calls[0]?.[1].aborted).toBe(false);
  });
  it('删失败：列表不动，提示失败', async () => {
    const { m } = mk(async () => false);
    await m.load();
    await m.remove(A.id, A.text, false);
    expect(m.get().items).toEqual([A, B]);
    expect(m.get().toast).toEqual({ k: 'failed' });
  });
  it('翻页：接着往后读，读过的留着；读失败给重试，不丢已读的', async () => {
    let fail = true;
    const { m, d } = mk(undefined, async (_s, c) => {
      if (c === null) return page([A, B], CUR, 3);
      if (fail) return null;
      return page([C], null, 3);
    });
    await m.load();
    expect(m.get()).toMatchObject({ next: CUR, total: 3 });
    await m.more();
    expect(m.get()).toMatchObject({ moreFailed: true, items: [A, B], next: CUR });
    fail = false;
    await m.more();
    expect(m.get()).toMatchObject({ moreFailed: false, items: [A, B, C], next: null });
    await m.more();
    expect(d.list).toHaveBeenCalledTimes(3);
  });
  it('翻到后面删一条再撤销：回到原位，不重读第一页', async () => {
    const { m, d } = mk(undefined, async (_s, c) => (c === null ? page([A, B], CUR, 3) : page([C], null, 3)));
    await m.load();
    await m.more();
    await m.remove(B.id, B.text, true);
    expect(m.get()).toMatchObject({ items: [A, C], total: 2 });
    await m.undo(B.id);
    expect(m.get()).toMatchObject({ items: [A, B, C], total: 3 });
    expect(d.list).toHaveBeenCalledTimes(2);
  });
  it('全部清空：没翻到的、这轮新记的提示条也算删了；在路上的翻页作废', async () => {
    let release: (v: ReturnType<typeof page>) => void = () => undefined;
    const { m } = mk(undefined, (_s, c) => (c === null ? Promise.resolve(page([A], CUR, 5000)) : new Promise((r) => { release = r; })));
    await m.load();
    const late = m.more();
    await m.clear(['73000000-0000-4000-8000-0000000000ff']);
    release(page([B], null, 5000));
    await late;
    expect(m.get()).toMatchObject({ items: [], next: null, total: 0 });
    expect(m.get().gone.has('73000000-0000-4000-8000-0000000000ff')).toBe(true);
  });
  it('全部清空：列表空、没有撤销条', async () => {
    const { m } = mk();
    await m.load();
    expect(await m.clear()).toBe(true);
    expect(m.get().items).toEqual([]);
    expect(m.get().toast).toBeNull();
    expect(m.get().gone.has(B.id)).toBe(true);
  });
});

describe('voiceAskOf', () => {
  it('各种回包', () => {
    expect(voiceAskOf({ transcript: ' 明天几点开会 ', quota_left: 3 })).toEqual({ ok: true, text: '明天几点开会' });
    expect(voiceAskOf({ consent_required: true })).toEqual({ ok: false, reason: 'consent' });
    expect(voiceAskOf({ quota_out: true, quota_left: 0 })).toEqual({ ok: false, reason: 'quota' });
    expect(voiceAskOf({ fallback: true, reason: 'quota' })).toEqual({ ok: false, reason: 'quota' });
    expect(voiceAskOf({ ai_failed: true, reason: 'timeout' })).toEqual({ ok: false, reason: 'failed' });
    expect(voiceAskOf(null)).toEqual({ ok: false, reason: 'failed' });
  });
});
