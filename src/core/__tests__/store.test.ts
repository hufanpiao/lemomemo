// core/store（架构 2.0、2.6）：快照不变时引用不变；只通知订阅了这个集合的人
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAllCollections, collection, createCollection } from '../store.ts';

interface Note {
  id: string;
  text: string;
}

beforeEach(() => {
  clearAllCollections();
});

describe('createCollection', () => {
  it('upsert / get / remove / clear', () => {
    const c = createCollection<Note>();
    c.upsert([
      { id: 'a', text: '1' },
      { id: 'b', text: '2' },
    ]);
    expect(c.get('a')?.text).toBe('1');
    c.upsert([{ id: 'a', text: '3' }]);
    expect(c.getSnapshot().map((n) => n.text)).toEqual(['3', '2']);
    c.remove(['b']);
    expect(c.getSnapshot()).toHaveLength(1);
    c.clear();
    expect(c.getSnapshot()).toEqual([]);
  });

  it('没变化时快照引用不变、不通知', () => {
    const c = createCollection<Note>();
    const l = vi.fn();
    c.subscribe(l);
    const s0 = c.getSnapshot();
    c.upsert([]);
    c.remove(['nope']);
    c.clear();
    expect(c.getSnapshot()).toBe(s0);
    expect(l).not.toHaveBeenCalled();
    c.upsert([{ id: 'a', text: '1' }]);
    expect(l).toHaveBeenCalledTimes(1);
    expect(c.getSnapshot()).not.toBe(s0);
  });

  it('取消订阅后不再通知', () => {
    const c = createCollection<Note>();
    const l = vi.fn();
    const off = c.subscribe(l);
    off();
    c.upsert([{ id: 'a', text: '1' }]);
    expect(l).not.toHaveBeenCalled();
  });
});

describe('collection 登记', () => {
  it('同名只建一次；一个集合变了不通知别的集合', () => {
    expect(collection<Note>('notes')).toBe(collection<Note>('notes'));
    const other = vi.fn();
    collection<Note>('todos').subscribe(other);
    collection<Note>('notes').upsert([{ id: 'a', text: '1' }]);
    expect(other).not.toHaveBeenCalled();
  });
});
