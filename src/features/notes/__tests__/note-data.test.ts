// 随手记的数据逻辑（B4 S1、S2）：列表条目、按天分组、分类胶囊、AI 小标；新建整行（不写 ai_status）、手动改分类写 manual
import { describe, expect, it } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { ruleCategory } from '../data/classify.ts';
import { contentOf, emptyForm, newNoteRow, patchOf } from '../data/note-edit.ts';
import { aliveCount, categoryColor, categoryCounts, groupByDay, noteItems, showsAi, titleAndSummary, type Row } from '../data/note-list.ts';

const TZ = 'Asia/Seoul';
const at = (d: string, hm: number) => msAt(d, hm, TZ);
const note = (id: string, over: Record<string, unknown> = {}): Row => ({
  id, title: null, body: '', is_private: false, category_id: null, category_source: 'none', category_seen: true, deleted_at: null, undone: false,
  created_at: at('2026-11-10', 9 * 60), ...over,
});
const cat = (id: string, name: string, over: Record<string, unknown> = {}): Row => ({ id, name, sort: 0, deleted_at: null, undone: false, merged_into: null, ...over });

describe('标题和摘要', () => {
  it('有标题：标题 + 正文当摘要；没标题：正文第一行当标题、后面的当摘要（空行跳过）', () => {
    expect(titleAndSummary('首尔林银杏黄了', '下周末带相机')).toEqual({ title: '首尔林银杏黄了', summary: '下周末带相机' });
    expect(titleAndSummary(null, '\n牛奶、鸡蛋\n\n猫砂\n종량제 봉투')).toEqual({ title: '牛奶、鸡蛋', summary: '猫砂 종량제 봉투' });
    expect(titleAndSummary('  ', '只有一行')).toEqual({ title: '只有一行', summary: '' });
  });
});

describe('列表条目', () => {
  const cats = [cat('c1', '工作灵感'), cat('c2', '韩国生活'), cat('c3', '旧分类', { merged_into: 'c1' })];
  const rows = [
    note('n1', { body: '今天的', created_at: at('2026-11-10', 14 * 60), category_id: 'c1', category_source: 'ai', category_seen: false }),
    note('n2', { body: '昨天的', created_at: at('2026-11-09', 21 * 60), category_id: 'c2' }),
    note('n3', { body: '更早', created_at: at('2026-10-21', 8 * 60 + 50) }),
    note('n4', { body: '删了的', deleted_at: 5 }),
    note('n5', { body: '撤销了的', undone: true }),
    note('n6', { body: null, title: null, is_private: true }),
    note('n7', { body: '分类已合并', category_id: 'c3', created_at: at('2026-11-10', 8 * 60) }),
  ];

  it('删了的、撤销的、隐私记不出；最近记的在前；分类已合并的归到合并进去的那个（S7）', () => {
    const items = noteItems(rows, cats, TZ);
    expect(items.map((i) => i.id)).toEqual(['n1', 'n7', 'n2', 'n3']);
    expect(items.find((i) => i.id === 'n7')?.categoryId).toBe('c1');
    expect(noteItems([note('nx', { body: 'x', category_id: 'gone' })], cats, TZ)[0]?.categoryId).toBeNull();
    expect(aliveCount(rows)).toBe(4);
  });

  it('“AI”小标：AI 分的、还没看过才标', () => {
    const items = noteItems(rows, cats, TZ);
    expect(items.filter((i) => i.ai).map((i) => i.id)).toEqual(['n1']);
    expect(showsAi(note('x', { category_source: 'ai', category_seen: true }))).toBe(false);
    expect(showsAi(note('x', { category_source: 'rule', category_seen: false }))).toBe(false);
  });

  it('按分类筛：只留这个分类的', () => {
    expect(noteItems(rows, cats, TZ, 'c2').map((i) => i.id)).toEqual(['n2']);
  });

  it('分组：今天 / 昨天 / 日期（按 current_tz 算哪一天）', () => {
    const g = groupByDay(noteItems(rows, cats, TZ), at('2026-11-10', 20 * 60), TZ);
    expect(g.map((x) => [x.key, x.date, x.items.length])).toEqual([
      ['today', '2026-11-10', 2],
      ['yesterday', '2026-11-09', 1],
      ['day', '2026-10-21', 1],
    ]);
  });

  it('分类胶囊：只算活着的普通随手记，条数多的在前', () => {
    const more = [...rows, note('n8', { body: 'x', category_id: 'c2' }), note('n10', { body: 'z', category_id: 'c2' }), note('n9', { body: 'y', category_id: 'c2', deleted_at: 1 })];
    expect(categoryCounts(more, cats, 'zh-CN')).toEqual([
      { id: 'c2', name: '韩国生活', color: null, count: 3 },
      { id: 'c1', name: '工作灵感', color: null, count: 2 },
    ]);
  });
});

describe('新建和修改', () => {
  const NOW = 1_700_000_000_000;

  it('新建整行：普通随手记、来源 page；不带 ai_status（系统列，库里默认 pending）；规则分到写 rule、没分到写 none', () => {
    const row = newNoteRow('id1', { ...emptyForm(), body: '买牛奶' }, NOW, null);
    expect(row).toEqual({
      id: 'id1', title: null, body: '买牛奶', is_private: false, category_id: null, category_source: 'none', category_seen: true, tags: [],
      converted_to: null, source: 'page', raw_text: '', batch_id: null, created_at: NOW, updated_at: NOW,
    });
    expect('ai_status' in row).toBe(false);
    expect(newNoteRow('id1', { ...emptyForm(), body: '买牛奶' }, NOW, 'c1')).toMatchObject({ category_id: 'c1', category_source: 'rule' });
    // 新建页上先手动选了分类：算手动
    expect(newNoteRow('id1', { title: '', body: 'x', category_id: 'c2' }, NOW)).toMatchObject({ category_id: 'c2', category_source: 'manual' });
  });

  it('标题和正文都空不算有内容', () => {
    expect(contentOf({ title: ' ', body: '\n', category_id: null })).toBe('');
    expect(contentOf({ title: '', body: '一句', category_id: null })).toBe('一句');
  });

  it('patchOf：只写变了的列加 updated_at；手动改分类同一个 patch 写 manual、已看；改成不分类也算手动', () => {
    const prev = { title: '', body: 'a', category_id: 'c1' };
    expect(patchOf({}, prev, prev, NOW)).toBeNull();
    expect(patchOf({}, prev, { ...prev, body: 'ab' }, NOW)).toEqual({ body: 'ab', updated_at: NOW });
    expect(patchOf({}, prev, { ...prev, title: ' 标题 ' }, NOW)).toEqual({ title: '标题', updated_at: NOW });
    expect(patchOf({}, prev, { ...prev, category_id: 'c2' }, NOW)).toEqual({ category_id: 'c2', category_source: 'manual', category_seen: true, updated_at: NOW });
    expect(patchOf({}, prev, { ...prev, category_id: null }, NOW)).toEqual({ category_id: null, category_source: 'manual', category_seen: true, updated_at: NOW });
  });

  it('本机规则分类现在是占位（后端 classify-rules 还没到）：一律 null', () => {
    expect(ruleCategory({ title: '', body: '买牛奶' }, [{ id: 'c1', name: '购物' }])).toBeNull();
  });
});

describe('分类颜色 categoryColor', () => {
  it('#rrggbb 照用；p1～p6 用项目色深色档；别的不画点', () => {
    expect(categoryColor('#6a4fc4')).toBe('#6a4fc4');
    expect(categoryColor('p4')).toBe('var(--p4s)');
    expect(categoryColor('lemon')).toBeNull();
    expect(categoryColor('#FFF')).toBeNull();
    expect(categoryColor(null)).toBeNull();
  });
});
