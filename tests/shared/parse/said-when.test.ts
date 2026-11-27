// i18n-exempt: 解析词表
// 11-25 负责人真机：语音“AI 自动整理的时候日期总是弄错”，“周五变成周日，后天变成明天，周五变成今天”（当天 2026-11-25 周三，首尔）。
// 做法（shared/logic/parse/said-when.ts 文件头）：AI 原样抄出说日子、说时刻的字（date_said、time_said），校验时按本机规则换算覆盖，
// 换算不出来才用 AI 自己的。这里钉住：负责人三个例子 AI 的 date 故意给错，最后都是 11-27；认不出用 AI 的；没说日子不硬塞；韩文；
// 两个新键不进校验后的条目（不回给客户端、不写库）；提示词附的 14 天日历表。
// deno 的 vitest 替身没有 it.each：逐条生成
import { describe, expect, it } from 'vitest';
import { saidWhen, SAID_MAX } from '../../../shared/logic/parse/said-when.ts';
import { checkParseOutput, checkVoiceOutput, type AiCheckCtx, type AiItem } from '../../../shared/schema/ai.ts';
import { calendarOf } from '../../../supabase/functions/_shared/ai/parse-core.ts';

const SEOUL = 'Asia/Seoul';
/** 2026-11-25（周三）10:00 首尔 */
const NOW = Date.UTC(2026, 10, 25, 1, 0);
const CTX: AiCheckCtx = { now: NOW, tz: SEOUL, features: ['event', 'todo', 'note', 'anniv'] };

const todo = (o: Record<string, unknown> = {}) => ({
  kind: 'todo', title: '交报告', date: null, time: null, duration_min: null, due: null, important: false,
  project: '工作', body: null, short: null, date_basis: null, date_said: null, time_said: null, ...o,
});
const event = (o: Record<string, unknown> = {}) => ({ ...todo({ kind: 'event', title: '开会' }), ...o });
const itemsOf = (v: ReturnType<typeof checkVoiceOutput>): AiItem[] => {
  if (!v.ok || v.value.intent !== 'record') throw new Error(`没过校验：${JSON.stringify(v)}`);
  return v.value.items;
};
const voice = (transcript: string, items: unknown[], ctx: AiCheckCtx = CTX) => itemsOf(checkVoiceOutput({ intent: 'record', confidence: 0.9, transcript, items }, ctx));

describe('负责人三个例子：AI 的日子故意给错，抄出的字按本机规则换算，最后都是 2026-11-27（周五）', () => {
  const CASES: [string, string, Record<string, unknown>][] = [
    ['周五变成周日', '周五开会', event({ date: '2026-11-29', date_basis: 'rel', date_said: '周五' })],
    ['后天变成明天', '后天交报告', todo({ due: '2026-11-26', date_basis: 'rel', date_said: '后天' })],
    ['周五变成今天', '周五交报告', todo({ due: '2026-11-25', date_basis: 'rel', date_said: '周五' })],
  ];
  for (const [name, said, it0] of CASES) {
    it(name, () => {
      const [got] = voice(said, [it0]);
      expect(got?.kind === 'event' ? got.date : got?.due).toBe('2026-11-27');
      expect(got?.date_basis).toBe('rel');
    });
  }
  it('文字的“＋”（ai-parse，checkParseOutput）同样换算', () => {
    const v = checkParseOutput({ intent: 'record', confidence: 0.9, items: [todo({ due: '2026-11-25', date_basis: 'rel', date_said: '周五' })] }, CTX);
    expect(v.ok && v.value.intent === 'record' && v.value.items[0]?.due).toBe('2026-11-27');
  });
});

describe('换算不出来、没说日子：用 AI 的，不硬塞', () => {
  it('抄出的字认不出（“周末”“过几天”）：用 AI 的 date', () => {
    expect(voice('周末开会', [event({ date: '2026-11-28', date_basis: 'rel', date_said: '周末' })])[0]?.date).toBe('2026-11-28');
    expect(voice('过几天交报告', [todo({ due: '2026-11-28', date_basis: 'rel', date_said: '过几天' })])[0]?.due).toBe('2026-11-28');
  });
  it('没说日子（date_said 为 null、空串、没给这个键）：AI 没给日子的仍然没有日子', () => {
    expect(voice('交报告', [todo()])[0]).toMatchObject({ due: null, date_basis: null });
    expect(voice('交报告', [todo({ date_said: '' })])[0]).toMatchObject({ due: null, date_basis: null });
    const { date_said: _a, time_said: _b, ...old } = todo();
    expect(voice('交报告', [old])[0]).toMatchObject({ due: null, date_basis: null });
  });
  it('两个日子（“周五或者周六”）、太长、重复说法（“每周一”）：拿不准，用 AI 的', () => {
    expect(voice('x', [todo({ due: '2026-11-28', date_basis: 'rel', date_said: '周五或者周六' })])[0]?.due).toBe('2026-11-28');
    expect(voice('x', [todo({ due: '2026-11-28', date_basis: 'rel', date_said: `周五${'啊'.repeat(SAID_MAX)}` })])[0]?.due).toBe('2026-11-28');
    expect(voice('x', [event({ date: '2026-11-30', time: '09:00', date_basis: 'rel', date_said: '每周一' })])[0]?.date).toBe('2026-11-30');
  });
  it('随手记、纪念日：不看抄出的字', () => {
    const [n] = voice('想法：周五试试', [{ ...todo({ kind: 'note', title: '周五试试', project: null, date_said: '周五' }) }]);
    expect(n).toMatchObject({ kind: 'note', date: null, due: null });
  });
});

describe('韩文', () => {
  it('“금요일”：AI 给成 11-29 也改成 11-27', () => {
    expect(voice('금요일 회의', [event({ title: '회의', date: '2026-11-29', date_basis: 'rel', date_said: '금요일' })])[0]?.date).toBe('2026-11-27');
  });
  it('“모레”：AI 给成 11-26 也改成 11-27', () => {
    expect(voice('모레 보고서', [todo({ title: '보고서', due: '2026-11-26', date_basis: 'rel', date_said: '모레' })])[0]?.due).toBe('2026-11-27');
  });
});

describe('时刻、其他日子说法', () => {
  it('time_said 换算覆盖 AI 的时刻：“下午3点”给成 03:00 也改成 15:00；没抄时刻的留 AI 的', () => {
    expect(voice('周五下午3点开会', [event({ date: '2026-11-29', time: '03:00', date_basis: 'rel', date_said: '周五', time_said: '下午3点' })])[0])
      .toMatchObject({ date: '2026-11-27', time: '15:00' });
    expect(voice('周五开会', [event({ date: '2026-11-27', time: '10:00', date_basis: 'rel', date_said: '周五' })])[0]?.time).toBe('10:00');
  });
  it('相对时刻（“半小时后”）连日子一起定；“今晚12点”跨到第二天', () => {
    expect(voice('半小时后开会', [event({ date: '2026-11-26', time: '11:00', date_basis: 'rel', time_said: '半小时后' })])[0])
      .toMatchObject({ date: '2026-11-25', time: '10:30' });
    expect(voice('今晚12点开会', [event({ date: '2026-11-25', time: '12:00', date_basis: 'rel', date_said: '今晚', time_said: '12点' })])[0])
      .toMatchObject({ date: '2026-11-26', time: '00:00' });
  });
  it('“下周一”“11月30号”“下个月5号”“这个月底”', () => {
    const at = (s: string) => saidWhen(s, null, NOW, SEOUL).day;
    expect(at('下周一')).toEqual({ date: '2026-11-30', basis: 'rel' });
    expect(at('11月30号')).toEqual({ date: '2026-11-30', basis: 'md' });
    expect(at('下个月5号')).toEqual({ date: '2026-12-05', basis: 'rel' });
    expect(at('这个月底')).toEqual({ date: '2026-11-30', basis: 'rel' });
  });
  it('两个新键不进校验后的条目（不回给客户端、不写库）', () => {
    const [got] = voice('周五开会', [event({ date: '2026-11-29', date_basis: 'rel', date_said: '周五', time_said: '下午3点' })]);
    expect(got && Object.keys(got)).not.toContain('date_said');
    expect(got && Object.keys(got)).not.toContain('time_said');
  });
});

describe('提示词附的日历表（parse-core.ts 的 calendarOf）', () => {
  it('从今天起 14 天，一周从周一开始，标今天、明天、后天', () => {
    const c = calendarOf('2026-11-25');
    const lines = c.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('  本周：2026-11-25 周三（今天）、2026-11-26 周四（明天）、2026-11-27 周五（后天）、2026-11-28 周六、2026-11-29 周日');
    expect(lines[1]).toMatch(/^ {2}下周：2026-11-30 周一、.*2026-12-06 周日$/);
    expect(lines[2]).toBe('  下下周：2026-12-07 周一、2026-12-08 周二');
    expect(c.match(/\d{4}-\d{2}-\d{2}/g)).toHaveLength(14);
    expect(calendarOf('')).toBe('');
  });
});
