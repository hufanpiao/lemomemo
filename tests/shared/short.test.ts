// shared/logic/short.ts（TC-B2-10、TC-B2-11；架构 5.12 第 2 点、R-104、第三轮架构 L3、第 9 节单元 short）
// emoji 的 ZWJ、变体选择符写成转义（LINT-bidi 不准原样出现）
import { describe, expect, it } from 'vitest';
import { displayShort, graphemeCount, itemShort, projectShort, shortPatchOnTitleChange } from '../../shared/logic/short.ts';
import { eventsWrite } from '../../shared/schema/rows.ts';

const ZWJ = '\u200D';
/** 一家四口（男、女、女孩、男孩，ZWJ 连起来）：一个字形簇、7 个码点 */
const FAMILY = ['\u{1F468}', '\u{1F469}', '\u{1F467}', '\u{1F466}'].join(ZWJ);
const CAKE = '\u{1F382}';

describe('itemShort：前 2 个字形簇（TC-B2-10）', () => {
  const cases: readonly [string, string, string][] = [
    ['中文', '校对稿件', '校对'],
    ['韩文（空格跳过）', '회의 준비', '회의'],
    ['英文也只取前 2 个字形簇（R-104 不设例外）', 'SignPlex review', 'Si'],
    ['emoji 开头、中间空格跳过', `${CAKE} 生日`, `${CAKE}生`],
    ['开头空白和标点去掉', '  【重要】 交报告', '重要'],
    ['开头的中文标点、英文标点', '“……校对”', '校对'],
    ['只有一个字', '饭', '饭'],
    ['空标题', '', ''],
    ['只有空白和标点', ' 。，!? ', ''],
  ];
  for (const [name, title, want] of cases) {
    it(name, () => {
      expect(itemShort(title)).toBe(want);
    });
  }

  it('ZWJ 家庭 emoji 算一个字形簇', () => {
    expect(itemShort(`${FAMILY}${FAMILY}${FAMILY}`)).toBe(`${FAMILY}${FAMILY}`);
    expect(itemShort(`${FAMILY}聚会`)).toBe(`${FAMILY}聚`);
    expect(graphemeCount(FAMILY)).toBe(1);
  });

  it('带组合符号的字算一个字形簇（e + U+0301、韩文初中声分开写）', () => {
    expect(itemShort('été')).toBe('ét');
    // 分开写的谚文字母（ᄒ ᅬ ᄋ ᅴ）NFC 规整成音节后取前 2 个
    expect(itemShort('회의 준')).toBe('회의');
  });

  it('projectShort 和 itemShort 同一个规则', () => {
    expect(projectShort('NEOX 品牌')).toBe('NE');
    expect(projectShort('  사이니지')).toBe('사이');
    expect(projectShort('')).toBe('');
  });
});

describe('displayShort：存了 short 用它，否则按标题取', () => {
  it('AI 或用户写的 short 原样用', () => {
    expect(displayShort({ title: '校对稿件', short: '审稿' })).toBe('审稿');
  });
  it('short 为 null 或只有空白时按标题取', () => {
    expect(displayShort({ title: '校对稿件', short: null })).toBe('校对');
    expect(displayShort({ title: '회의 준비', short: '  ' })).toBe('회의');
  });
});

describe('改标题时简称的来源（TC-B2-11，第三轮架构 L3）', () => {
  it("short_by = 'ai'：同一个 patch 里清空 short、short_by", () => {
    expect(shortPatchOnTitleChange({ short_by: 'ai' })).toEqual({ short: null, short_by: null });
  });
  it("short_by = 'user'：不动", () => {
    expect(shortPatchOnTitleChange({ short_by: 'user' })).toEqual({});
  });
  it('没有 short（null）：不动', () => {
    expect(shortPatchOnTitleChange({ short_by: null })).toEqual({});
  });

  it('两个 ZWJ 家庭 emoji 的简称能写进 events.short（≤ 32 码点）', () => {
    const short = `${FAMILY}${FAMILY}`;
    expect([...short].length).toBe(14);
    const row = {
      id: '00000000-0000-4000-8000-000000000001',
      title: '家庭聚会',
      date: '2026-11-03',
      time: null,
      tz: null,
      duration_min: 60,
      project: '',
      note: '',
      source: 'page',
      raw_text: '',
      location: '',
      short,
      short_by: 'user',
      push_show_title: null,
      batch_id: null,
      remind_min: null,
      remind_days: null,
      notified_for: null,
      snooze_at: null,
      deleted_at: null,
      undone: false,
      created_at: 1,
      updated_at: 1,
    };
    expect(eventsWrite.safeParse(row).success).toBe(true);
  });
});
