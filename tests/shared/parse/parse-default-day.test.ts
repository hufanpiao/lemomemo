// 本机规则：B3 任务单补充（11-07 架构师）R5 今天已经过去的时刻、R6 默认日子（日历页选中的那天，R-353）、R8 只用空格隔开的两件事、
// R9 默认日子补出来的不算认出了日子
import { describe, expect, it } from 'vitest';
import { confidence, parseSplit, type ParseResult } from '../../../shared/logic/parse/index.ts';

const SEOUL = 'Asia/Seoul';
/** 2026-10-28（周三）15:00 首尔 */
const AFTERNOON = Date.UTC(2026, 9, 28, 6, 0);
/** 2026-10-28（周三）23:30 首尔 */
const LATE = Date.UTC(2026, 9, 28, 14, 30);
const PICKED = '2026-11-20';

function fmt(r: ParseResult): string {
  return r.items
    .map((it) => `${it.kind.charAt(0).toUpperCase()} ${it.title} ${(it.date ?? it.due)?.slice(5) ?? '-'} ${it.time ?? '-'} ${it.date_basis ?? '-'}${it.duration_min ? ' d' + it.duration_min : ''}`)
    .join(' ‖ ');
}
const one = (text: string, now = AFTERNOON, defaultDay?: string, locale: 'zh' | 'ko' = 'zh') => {
  const r = parseSplit(text, now, SEOUL, locale, [], defaultDay ? { features: ['event', 'todo'], defaultDay } : { features: ['event', 'todo'] });
  return [fmt(r), confidence(r)];
};

describe('R6 默认日子（日历页选中 11-20）', () => {
  it('任务单新增用例：“下午三点开会”记 11-20，“明天开会”记真实的明天，“买牛奶”记 11-20 的待办（R9：仍没把握）', () => {
    expect(one('下午三点开会', AFTERNOON, PICKED)).toEqual(['E 开会 11-20 15:00 rel', 'sure']);
    expect(one('明天开会', AFTERNOON, PICKED)).toEqual(['T 开会 10-29 - rel', 'sure']);
    expect(one('买牛奶', AFTERNOON, PICKED)).toEqual(['T 买牛奶 11-20 - rel', 'unsure']);
  });
  it('R9：传了默认日子，“买牛奶”照旧没把握、doubt 含 no_date（交给 AI），本机结果的日子是选中那天；“明天买牛奶”传不传都有把握、记明天', () => {
    const r = parseSplit('买牛奶', AFTERNOON, SEOUL, 'zh', [], { defaultDay: PICKED });
    expect([r.doubts, confidence(r), r.items[0]?.due]).toEqual([['no_date'], 'unsure', PICKED]);
    for (const dd of [undefined, PICKED]) {
      expect(one('明天买牛奶', AFTERNOON, dd), String(dd)).toEqual(['T 买牛奶 10-29 - rel', 'sure']);
    }
    // 后一件沿用的也是补出来的日子：照样没把握
    const two = parseSplit('买牛奶，再买鸡蛋', AFTERNOON, SEOUL, 'zh', [], { defaultDay: PICKED });
    expect([two.doubts.includes('no_date'), two.items.map((i) => i.due)]).toEqual([true, [PICKED, PICKED]]);
  });
  it('韩文同一口径；只说时刻的待办截止、只说时段的也记选中那天；下周三照旧按真实的今天算', () => {
    expect(one('오후 3시 회의', AFTERNOON, PICKED, 'ko')).toEqual(['E 회의 11-20 15:00 rel', 'sure']);
    expect(one('우유 사기', AFTERNOON, PICKED, 'ko')).toEqual(['T 우유 사기 11-20 - rel', 'unsure']);
    expect(one('5点前交报告', AFTERNOON, PICKED)).toEqual(['T 交报告 11-20 17:00 rel', 'sure']);
    expect(one('晚上和小王吃饭', AFTERNOON, PICKED)).toEqual(['T 和小王吃饭 11-20 - rel', 'sure']);
    expect(one('下周三交报告', AFTERNOON, PICKED)).toEqual(['T 交报告 11-04 - rel', 'sure']);
  });
  it('一句里有的说了日子有的没说：说了的照说的，没说的记选中那天', () => {
    expect(one('买牛奶，明天下午3点开会', AFTERNOON, PICKED)).toEqual(['T 买牛奶 11-20 - rel ‖ E 开会 10-29 15:00 rel', 'unsure']);
  });
  it('不传时行为不变：没时刻的待办不记日子（没把握），只说时刻记今天', () => {
    expect(one('买牛奶')).toEqual(['T 买牛奶 - - -', 'unsure']);
    expect(one('下午三点开会')).toEqual(['E 开会 10-28 15:00 rel', 'sure']);
  });
  it('传的就是今天：和不传一样记今天，没时刻的待办也记今天（R9：仍没把握）', () => {
    expect(one('下午三点开会', AFTERNOON, '2026-10-28')).toEqual(['E 开会 10-28 15:00 rel', 'sure']);
    expect(one('买牛奶', AFTERNOON, '2026-10-28')).toEqual(['T 买牛奶 10-28 - rel', 'unsure']);
  });
});

describe('R5 今天已经过去的时刻', () => {
  it('① 没说日子、时刻已过：照样记今天、有把握（15:00 说“11点开会”）', () => {
    expect(one('11点开会')).toEqual(['E 开会 10-28 11:00 rel', 'sure']);
    expect(one('11시 회의', AFTERNOON, undefined, 'ko')).toEqual(['E 회의 10-28 11:00 rel', 'sure']);
  });
  it('③ 凌晨 / 새벽例外记明天（23:30 说“凌晨1点吃药”）；④ 选中的不是今天时记选中那天，选中今天照样例外', () => {
    expect(one('凌晨1点吃药', LATE)).toEqual(['E 吃药 10-29 01:00 rel', 'sure']);
    expect(one('凌晨1点吃药', LATE, PICKED)).toEqual(['E 吃药 11-20 01:00 rel', 'sure']);
    expect(one('새벽 1시 약 먹기', LATE, PICKED, 'ko')).toEqual(['E 약 먹기 11-20 01:00 rel', 'sure']);
    expect(one('凌晨1点吃药', LATE, '2026-10-28')).toEqual(['E 吃药 10-29 01:00 rel', 'sure']);
  });
  it('③ 截止时刻也适用（第三轮代码审 M1）：23:30 说“凌晨1点前交稿”记明天 01:00 截止；00:30 说记今天', () => {
    expect(one('凌晨1点前交稿', LATE)).toEqual(['T 交稿 10-29 01:00 rel', 'sure']);
    expect(one('새벽 1시까지 원고 내기', LATE, undefined, 'ko')).toEqual(['T 원고 내기 10-29 01:00 rel', 'sure']);
    expect(one('凌晨1点前交稿', Date.UTC(2026, 9, 27, 15, 30))).toEqual(['T 交稿 10-28 01:00 rel', 'sure']);
  });
  it('“晚上 1～5 点”本来就是第二天：选中 11-20 记 11-21', () => {
    expect(one('晚上1点睡觉', LATE, PICKED)).toEqual(['E 睡觉 11-21 01:00 rel', 'sure']);
  });
});

describe('R8 只用空格隔开的两件事：不拆、判没把握', () => {
  it('中文：“下午3点开会 晚上看电影”', () => {
    const r = parseSplit('下午3点开会 晚上看电影', AFTERNOON, SEOUL, 'zh', []);
    expect([r.items.length, r.doubts.includes('leftover'), confidence(r)]).toEqual([1, true, 'unsure']);
  });
  it('韩文：“오후 3시 회의 저녁 영화”', () => {
    const r = parseSplit('오후 3시 회의 저녁 영화', AFTERNOON, SEOUL, 'ko', []);
    expect([r.items.length, r.doubts.includes('leftover'), confidence(r)]).toEqual([1, true, 'unsure']);
  });
  it('时段词本身是事由的不算：“내일 12시 점심”“저녁 7시 저녁 식사”“晚上7点吃晚饭”照常有把握', () => {
    expect(one('내일 12시 점심', AFTERNOON, undefined, 'ko')).toEqual(['E 점심 10-29 12:00 rel', 'sure']);
    expect(one('저녁 7시 저녁 식사', AFTERNOON, undefined, 'ko')).toEqual(['E 저녁 식사 10-28 19:00 rel', 'sure']);
    expect(one('晚上7点吃晚饭')).toEqual(['E 吃晚饭 10-28 19:00 rel', 'sure']);
  });
});
