// 下拉搜索的本机筛选（R-437；data/pull-local.ts）：每页查哪几个字段、隐私记不搜、子任务命中给片段
import { describe, expect, it } from 'vitest';
import { pullFind, pullIndex } from '../data/pull-local.ts';
import type { Row } from '../data/find-local.ts';

const TZ = 'Asia/Seoul' as never;
const NOW = Date.UTC(2026, 10, 14, 3);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const live = { deleted_at: null, undone: false };

const notes: Row[] = [
  { id: id(1), ...live, title: '拉面店', body: '弘大那家，汤头很浓', category_id: id(9), tags: ['美食'], is_private: false, created_at: NOW },
  { id: id(2), ...live, title: '证件放哪', body: '护照在抽屉', category_id: null, is_private: true, created_at: NOW },
  { id: id(3), deleted_at: NOW, undone: false, title: '删了的拉面', body: '', category_id: null, is_private: false, created_at: NOW },
];
const cats: Row[] = [{ id: id(9), ...live, name: '吃喝', merged_into: null }];

describe('pull-local', () => {
  it('随手记：按标题、正文、分类名筛；隐私记、删了的不出；标签不算（R-437 只说分类）', () => {
    const idx = pullIndex('note', notes, cats, TZ);
    expect(idx.map((x) => x.id)).toEqual([id(1)]);
    expect(pullFind(idx, '拉面').map((h) => h.item.id)).toEqual([id(1)]);
    expect(pullFind(idx, '汤头').map((h) => h.snippet)).toEqual(['弘大那家，汤头很浓']);
    expect(pullFind(idx, '吃喝').map((h) => h.item.id)).toEqual([id(1)]);
    expect(pullFind(idx, '美食')).toEqual([]);
    expect(pullFind(idx, '护照')).toEqual([]);
    expect(pullFind(idx, '')).toEqual([]);
  });

  it('待办：按标题和子任务筛；子任务命中时片段是那一项；删了的子任务不算；备注不算', () => {
    const todos: Row[] = [
      { id: id(4), ...live, title: '出差准备', note: '记得带充电器', project: '', due: null, done: false },
      { id: id(5), ...live, title: '买护照夹', note: '', project: '', due: null, done: true },
    ];
    const items: Row[] = [
      { id: id(6), ...live, todo_id: id(4), title: '带护照', done: false },
      { id: id(7), deleted_at: NOW, undone: false, todo_id: id(4), title: '订机票', done: false },
    ];
    const idx = pullIndex('todo', todos, items, TZ);
    const hits = pullFind(idx, '护照');
    expect(hits.map((h) => [h.item.id, h.snippet])).toEqual([[id(5), null], [id(4), '带护照']]);
    expect(hits[0]?.item.done).toBe(true);
    expect(pullFind(idx, '机票')).toEqual([]);
    expect(pullFind(idx, '充电器')).toEqual([]);
  });

  it('日程：只看标题（地点、备注不算）', () => {
    const events: Row[] = [{ id: id(8), ...live, title: '看牙医', location: '江南站', note: '带医保卡', date: '2026-11-10', time: '15:00' }];
    const idx = pullIndex('event', events, [], TZ);
    expect(pullFind(idx, '牙医').map((h) => h.item.id)).toEqual([id(8)]);
    expect(idx[0]?.date).toBe('2026-11-10');
    expect(pullFind(idx, '江南')).toEqual([]);
    expect(pullFind(idx, '医保')).toEqual([]);
  });
});
