// 本机关键词查找（B4b-2；data/find-local.ts）：覆盖哪些、隐私记不进、时间筛选、合并分组、高亮、片段、最近找过
import { describe, expect, it } from 'vitest';
import {
  buildIndex, countKinds, findLocal, inRange, markRanges, mergeFind, onlyKind, rangeOf, semReady, snippetOf, type FindSources, type Row,
} from '../data/find-local.ts';
import { pushRecent, RECENT_MAX } from '../data/find-recent.ts';

const TZ = 'Asia/Seoul' as never;
const NOW = Date.UTC(2026, 10, 14, 3); // 首尔 2026-11-14（周六）
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const live = { deleted_at: null, undone: false };

function src(over: Partial<FindSources> = {}): FindSources {
  return {
    events: [{ id: id(1), ...live, title: '看牙医', location: '江南站', note: '带医保卡', date: '2026-11-10', time: '15:00' }],
    todos: [{ id: id(2), ...live, title: '交发票', note: '', project: '报销', due: '2026-11-20', done: false }],
    anniversaries: [{ id: id(3), ...live, name: '妈妈生日', note: '', next_date: '2026-12-01' }],
    notes: [
      { id: id(4), ...live, title: '拉面店', body: '弘大那家拉面店，汤头很浓，下次带朋友去', tags: ['美食'], is_private: false, created_at: NOW },
      { id: id(5), ...live, title: '隐私的牙医记录', body: '牙医', is_private: true, created_at: NOW },
    ] as Row[],
    note_images: [
      { id: id(6), ...live, note_id: id(4), bucket: 'files', ai_desc: '一碗拉面', ai_tags: ['라면'], has_thumb: true },
      { id: id(7), ...live, note_id: id(5), bucket: 'vault-images', ai_desc: '牙医', ai_tags: [] },
    ] as Row[],
    note_files: [
      { id: id(8), ...live, note_id: id(4), kind: 'pdf', name: '发票.pdf', text_excerpt: '金额 3 万韩元', is_vault: false, check_status: 'ok' },
      { id: id(9), ...live, note_id: id(4), kind: 'pdf', name: '牙医.pdf', text_excerpt: '', is_vault: true, check_status: 'ok' },
    ] as Row[],
    ...over,
  };
}

describe('find-local', () => {
  it('覆盖日程、待办、纪念日、随手记、图片描述、文档文字；隐私记、隐私图片、隐私文档不进', () => {
    const idx = buildIndex(src(), TZ);
    expect(idx.map((x) => `${x.kind}:${x.id.slice(-1)}`).sort()).toEqual(['anniv:3', 'event:1', 'file:8', 'image:6', 'note:4', 'todo:2'].sort());
    expect(findLocal(idx, '牙医').map((h) => h.item.kind)).toEqual(['event']);
    expect(findLocal(idx, '万韩元').map((h) => h.item.kind)).toEqual(['file']);
    expect(findLocal(idx, '라면').map((h) => h.item.kind)).toEqual(['image']);
  });

  it('删了、撤销的不进；父随手记删了，图片和文档也不进', () => {
    const s = src();
    const [n0] = s.notes;
    const [e0] = s.events;
    if (!n0 || !e0) throw new Error('样例缺行');
    const idx = buildIndex({ ...s, notes: [{ ...n0, deleted_at: NOW }], events: [{ ...e0, undone: true }] }, TZ);
    expect(idx.map((x) => x.kind).sort()).toEqual(['anniv', 'todo']);
  });

  it('时间筛选：上周按周一起算、这个月；没有日子的不出', () => {
    const idx = buildIndex(src(), TZ);
    expect(rangeOf('lastWeek', NOW, TZ)).toEqual({ from: '2026-11-02', to: '2026-11-08' });
    expect(rangeOf('thisMonth', NOW, TZ)).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(rangeOf('any', NOW, TZ)).toBeNull();
    expect(inRange(idx, rangeOf('thisMonth', NOW, TZ)).map((x) => x.kind).sort()).toEqual(['event', 'file', 'image', 'note', 'todo']);
  });

  it('合并：两边都中 → 最相关；只有关键词 → 关键词；只有意思 → 意思相近（本机没有的、隐私记的丢掉）', () => {
    const idx = buildIndex(src(), TZ);
    const kw = findLocal(idx, '拉面');
    const g = mergeFind(kw, [
      { kind: 'note', id: id(4), score: 0.9 }, { kind: 'todo', id: id(2), score: 0.7 }, { kind: 'note', id: id(5), score: 0.95 },
      { kind: 'event', id: id(99), score: 0.8 },
    ], idx, '拉面');
    expect(g.top.map((h) => h.item.id)).toEqual([id(4)]);
    expect(g.kw.map((h) => h.item.id)).toEqual([id(6)]);
    expect(g.sem.map((h) => h.item.id)).toEqual([id(2)]);
    expect(countKinds(g)).toMatchObject({ all: 3, note: 1, image: 1, todo: 1 });
    expect(onlyKind(g, 'todo')).toEqual({ top: [], kw: [], sem: g.sem });
    expect(mergeFind(kw, null, idx, '拉面')).toEqual({ top: [], kw, sem: [] });
  });

  it('高亮、片段、送服务器的门槛', () => {
    expect(markRanges('看牙医 牙医', '牙医')).toEqual([[1, 3], [4, 6]]);
    expect(markRanges('ＡＢＣ', 'abc')).toEqual([[0, 3]]);
    expect(snippetOf('弘大那家拉面店，汤头很浓，下次带朋友去，还要再吃一次很长很长的一段话', '朋友')).toMatch(/^…[^…]*朋友[^…]*$/);
    expect(semReady('a')).toBe(false);
    expect(semReady('牙医')).toBe(true);
  });

  it('最近找过：新的在前、去重、最多 6 条、空的不记', () => {
    expect(pushRecent(['a', 'B'], ' b ')).toEqual(['b', 'a']);
    expect(pushRecent(['a'], '  ')).toEqual(['a']);
    expect(pushRecent(['1', '2', '3', '4', '5', '6'], '7')).toHaveLength(RECENT_MAX);
  });
});

describe('buildIndex：日程按设备时区换算日子和时刻（B4b-3，4.6）', () => {
  const ev = (over: Partial<Row>): Row => ({ id: id(20), ...live, title: '晨会', location: '', note: '', date: '2026-11-10', time: '01:00', tz: 'Asia/Seoul', duration_min: 30, ...over });
  const evOf = (r: Row, tz: string) => buildIndex(src({ events: [r] }), tz as never).find((x) => x.kind === 'event');

  it('首尔记的 11-10 01:00，设备在洛杉矶：日子变成 11-09、时刻 08:00；设备在首尔不变', () => {
    expect(evOf(ev({}), 'America/Los_Angeles')).toMatchObject({ date: '2026-11-09', time: '08:00' });
    expect(evOf(ev({}), 'Asia/Seoul')).toMatchObject({ date: '2026-11-10', time: '01:00' });
  });
  it('全天日程不换算、没有时刻；没写 tz 的按设备时区', () => {
    expect(evOf(ev({ time: null }), 'America/Los_Angeles')).toMatchObject({ date: '2026-11-10', time: null });
    expect(evOf(ev({ tz: null }), 'America/Los_Angeles')).toMatchObject({ date: '2026-11-10', time: '01:00' });
  });
  it('时刻格式坏了的照原值', () => {
    expect(evOf(ev({ time: '25:99' }), 'America/Los_Angeles')).toMatchObject({ date: '2026-11-10', time: '25:99' });
  });
});
