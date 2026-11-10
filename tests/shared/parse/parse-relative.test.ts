// i18n-exempt: 解析词表
// R-374 中文相对时刻（11-10 负责人“只加中文”）：本机规则认“N 分钟后 / 半小时后 / 一个半小时后 / N 个小时后 / 一刻钟后 / 过 N 分钟”，
// 按记下那一刻（now）算成日子和时刻，跨午夜进第二天；和日期词、具体时刻冲突以相对时刻为准、判没把握；韩文不做。
// 结果写法同 parse-split.test.ts：类型首字母 标题 月-日 时刻 basis。
import { describe, expect, it } from 'vitest';
import { confidence, parseSplit, type ParseResult } from '../../../shared/logic/parse/index.ts';

const SEOUL = 'Asia/Seoul';
const LA = 'America/Los_Angeles';
/** 2026-11-02（周一）10:00 首尔 */
const BANK_NOW = Date.UTC(2026, 10, 2, 1, 0);

const fmt = (r: ParseResult): string =>
  r.items.map((it) => `${it.kind.charAt(0).toUpperCase()} ${it.title} ${(it.date ?? it.due)?.slice(5) ?? '-'} ${it.time ?? '-'} ${it.date_basis ?? '-'}`).join(' ‖ ');
function first(r: ParseResult): ParseResult['items'][number] {
  const it = r.items[0];
  if (!it) throw new Error('没有结果');
  return it;
}

describe('R-374 中文相对时刻：按记下那一刻（now）算', () => {
  // BANK_NOW = 2026-11-02 10:00 首尔
  const LATE = Date.UTC(2026, 10, 2, 14, 40); // 23:40 首尔
  const sure = (t: string, now = BANK_NOW) => {
    const r = parseSplit(t, now, SEOUL, 'zh', []);
    return `${fmt(r)} ${confidence(r)}`;
  };
  // deno 的 vitest 替身没有 it.each：逐条生成
  const CASES: [string, string][] = [
    ['3分钟后提醒我', 'E 提醒 11-02 10:03 rel'],
    ['三分钟以后提醒我', 'E 提醒 11-02 10:03 rel'],
    ['3 分钟后提醒我喝水', 'E 喝水 11-02 10:03 rel'],
    ['半小时后开会', 'E 开会 11-02 10:30 rel'],
    ['半个小时之后开会', 'E 开会 11-02 10:30 rel'],
    ['一个半小时后开会', 'E 开会 11-02 11:30 rel'],
    ['两个小时后去银行', 'E 去银行 11-02 12:00 rel'],
    ['2小时后去银行', 'E 去银行 11-02 12:00 rel'],
    ['两个半小时后接孩子', 'E 接孩子 11-02 12:30 rel'],
    ['1小时20分钟后吃药', 'E 吃药 11-02 11:20 rel'],
    ['十五分钟后打电话', 'E 打电话 11-02 10:15 rel'],
    ['二十分钟过后开会', 'E 开会 11-02 10:20 rel'],
    ['一刻钟后出门', 'E 出门 11-02 10:15 rel'],
    ['过10分钟提醒我关火', 'E 关火 11-02 10:10 rel'],
    ['再过10分钟提醒我关火', 'E 关火 11-02 10:10 rel'],
    ['48小时后交稿', 'E 交稿 11-04 10:00 rel'],
  ];
  for (const [t, want] of CASES) {
    it(`${t} → ${want}，有把握`, () => {
      expect(sure(t)).toBe(`${want} sure`);
    });
  }

  it('跨午夜进到第二天', () => {
    expect(sure('半小时后开会', LATE)).toBe('E 开会 11-03 00:10 rel sure');
    expect(sure('3小时后提醒我', LATE)).toBe('E 提醒 11-03 02:40 rel sure');
  });

  it('只看传进来的 tz：洛杉矶同一刻是 11-01 17:00', () => {
    expect(fmt(parseSplit('半小时后开会', BANK_NOW, LA, 'zh', []))).toBe('E 开会 11-01 17:30 rel');
  });

  it('秒数舍去：10:00:50 说“3分钟后”是 10:03', () => {
    expect(sure('3分钟后提醒我', BANK_NOW + 50_000)).toBe('E 提醒 11-02 10:03 rel sure');
  });

  it('和日期词、具体时刻冲突：以相对时刻为准，另外那个从标题去掉，判没把握（rel_conflict）', () => {
    for (const t of ['明天半小时后开会', '半小时后3点开会', '周五两小时后开会']) {
      const r = parseSplit(t, BANK_NOW, SEOUL, 'zh', []);
      expect(fmt(r)).toMatch(/^E 开会 11-02 1[02]:[03]0 rel$/);
      expect(r.doubts).toContain('rel_conflict');
      expect(confidence(r)).toBe('unsure');
    }
  });

  it('和时段词同说：时段词从标题去掉，判没把握（leftover 一路）', () => {
    const r = parseSplit('晚上半小时后看电影', BANK_NOW, SEOUL, 'zh', []);
    expect(fmt(r)).toBe('E 看电影 11-02 10:30 rel');
    expect(confidence(r)).toBe('unsure');
  });

  it('日历页选中别的日子（defaultDay）也按真实的现在算', () => {
    const r = parseSplit('半小时后开会', BANK_NOW, SEOUL, 'zh', [], { defaultDay: '2026-11-20' });
    expect(`${fmt(r)} ${confidence(r)}`).toBe('E 开会 11-02 10:30 rel sure');
  });

  it('前一段只有相对时刻：并进下一段；后一段沿用这个日子', () => {
    expect(fmt(parseSplit('半小时后，开会', BANK_NOW, SEOUL, 'zh', []))).toBe('E 开会 11-02 10:30 rel');
  });

  it('“超过 / 不超过 / 经过”里的“过”不算（代码审 M1）：是时长、限度，不记时刻、不判有把握', () => {
    for (const t of ['学习不超过30分钟', '跑步超过半小时', '每次不超过两小时', '经过两小时讨论']) {
      const r = parseSplit(t, BANK_NOW, SEOUL, 'zh', []);
      expect(first(r).time, t).toBeNull();
      expect(first(r).title, t).toBe(t);
      expect(confidence(r), t).toBe('unsure');
    }
  });

  it('“过”只认白名单（代码审第二轮）：别的字后面的“过”、字后隔空格的“过”都不认，标题原样、判没把握', () => {
    const bad = ['熬过两小时', '睡过两小时', '长过两小时', '看过10分钟', '晚过半小时', '多过半小时',
      '挺过两小时', '撑过两小时', '跳过10分钟', '略过10分钟', '胜过半小时', '坐过两小时', '路过10分钟',
      '高过半小时', '快过10分钟', '超 过30分钟'];
    for (const t of bad) {
      const r = parseSplit(t, BANK_NOW, SEOUL, 'zh', []);
      expect(first(r).time, t).toBeNull();
      // 标题原样（汉字之间的空格本来就会收掉，“超 过30分钟”记成“超过30分钟”）
      expect(first(r).title, t).toBe(t.replace(' ', ''));
      expect(confidence(r), t).toBe('unsure');
    }
  });

  it('白名单里的“过”照认：开头、标点后、再 / 等 / 大概 / 大约 / 约 / 差不多后面；带“后”的“不过10分钟后到”照认', () => {
    const okCases: [string, string][] = [
      ['再过10分钟出门', '10:10'], ['过半小时开会', '10:30'], ['大概过半小时到', '10:30'],
      ['，过10分钟出门', '10:10'], ['大约过两小时到', '12:00'], ['约过一刻钟出门', '10:15'],
      ['差不多过半小时到', '10:30'], ['等过10分钟出门', '10:10'], ['再 过10分钟出门', '10:10'],
      ['不过10分钟后到', '10:10'],
    ];
    for (const [t, hm] of okCases) {
      const r = parseSplit(t, BANK_NOW, SEOUL, 'zh', []);
      expect(first(r).time, t).toBe(hm);
      expect(first(r).date_basis, t).toBe('rel');
    }
  });

  it('不认的：不带“后 / 过”的时长、超过 72 小时、带重复说法、韩文', () => {
    expect(sure('开会两小时')).toBe('T 开会两小时 - - - unsure');
    expect(sure('100小时后交稿')).toBe('T 100小时后交稿 - - - unsure');
    expect(first(parseSplit('每天半小时后喝水', BANK_NOW, SEOUL, 'zh', [])).time).toBeNull();
    expect(first(parseSplit('30분 후에 회의', BANK_NOW, SEOUL, 'ko', [])).time).toBeNull();
  });
});
