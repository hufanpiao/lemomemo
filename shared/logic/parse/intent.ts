// i18n-exempt: 解析词表
// “＋”打字的本机意图规则 localIntent（架构 5.14 第 2 点）：记下、查找、总结、取消、改期、完成，并解析出 query 或 target、to。
// 不变量：句式表照 5.14 原文；查找、总结的说法每种只有一张表（PHRASES），命中、祈使位置、去掉句式三组正则都从表生成；
// 有没有把握只在 sureQuery 判（不丢记录：哪条不满足都没把握）；记下遇到句式表外的疑似取消 / 改期 / 完成词也没把握。
// 取消、改期、完成的解析在 target-parse.ts。纯函数：now、tz 由调用方传入，不读时钟、不写日志。
import { addDays, todayOf, type DateStr } from '../../core/date.ts';
import type { Tz } from '../../core/tz.ts';
import { INTENT_KINDS, type IntentKind } from '../../schema/kinds.ts';
import { firstOfMonth, lastOfMonth, monthOf, shiftMonth } from '../calendar/cal-nav.ts';
import { cutGraphemes } from '../short.ts';
import { KO_WEEK, takeDate, weekday, weekPrefix, ZH_WEEK_PREFIX } from './date-words.ts';
import { cleanTitle, stripRequests, takeKindWords, takeNamedKind } from './marks.ts';
import type { PlusTarget } from './resolve-target.ts';
import { BULK_RE, RELATED_RE, saysOverdue, takeOverdue, takeTarget, targetIntentOf } from './target-parse.ts';
import { LEFTOVER_RE, prepare, QUICK_MAX, take, type Rest } from './text.ts';
import { takePeriodOnly } from './time-words.ts';

// 意图枚举、query、to 的类型定义在 shared/schema/intent.ts（AI 输出校验、函数返回和本机规则共用一份），这里转出给老调用方
import { QUERY_TEXT_MAX, type PlusIntent, type PlusQuery, type PlusTo } from '../../schema/intent.ts';
export { PLUS_INTENTS, type PlusIntent, type PlusQuery, type PlusTo, type QueryDone } from '../../schema/intent.ts';
export interface LocalIntent {
  intent: PlusIntent;
  /** 有把握就不调 AI；没把握时在线交给 AI，离线先按记下保存 */
  sure: boolean;
  query: PlusQuery | null;
  target: PlusTarget | null;
  to: PlusTo | null;
  /** 取消、完成说的是“都 + 泛指词”：卡片请用户在列表里操作 */
  bulkRefused: boolean;
  /** 取消时说了“相关待办”：卡片加一句“相关的待办请在列表里删” */
  relatedTodos: boolean;
}
export interface IntentOpts {
  /** 隐私记页面是 vault：没有日程待办，取消、改期、完成按记下 */
  scope?: 'main' | 'vault';
}

/**
 * 说法在哪儿才算祈使：head 句首（前面可带“请 / 帮我”）、tail 句尾（后面可带一个标点）、ask 从它起到句末是问句、null 只算说到了。
 * 名词用法（“交季度总结”）不在祈使位置；句首的名词用法（“总结报告周五交”）由 buildQuery 的 recordLike 拦。
 */
type Pos = 'head' | 'tail' | 'ask' | null;
/** 一条说法：word 是正则源码（去掉句式时去它）；when 是后面必须跟着的（命中、祈使才看）；hit 为 false 的单说不算命中（“有什么”要配“看一下”或问号） */
interface Phrase {
  word: string;
  pos: Pos;
  when?: string;
  hit?: false;
}
type QueryKind = 'search' | 'summary' | 'list' | 'conflict';
/** 查找、总结的说法表：加词只改这里 */
const PHRASES: Readonly<Record<QueryKind, readonly Phrase[]>> = {
  search: [
    { word: '帮我找(?:一下)?', pos: 'head' }, { word: '搜一下', pos: 'head' }, { word: '查一下', pos: 'head' },
    { word: '看一下', pos: 'head', when: '.*有什么' }, { word: '有什么', pos: 'ask', hit: false },
    { word: '찾아\\s*줘', pos: 'tail' }, { word: '뭐\\s*있어', pos: 'tail' }, { word: '[?？]', pos: null, when: '\\s*$' },
  ],
  summary: [{ word: '总结(?:一下)?', pos: 'head' }, { word: '汇总(?:一下)?', pos: 'head' }, { word: '정리해\\s*줘', pos: 'tail' }],
  list: ['列出', '列一下', '给我看看?', '显示', '有哪些', '보여\\s*줘', '목록', '있는지\\s*확인해\\s*줘', '뭐\\s*있는지\\s*알려\\s*줘'].map((word) => ({ word, pos: null })),
  conflict: ['冲突', '撞了', '重叠', '겹치\\S*'].map((word) => ({ word, pos: null })),
};
/** 句首的客气话：祈使位置和去掉句式以后都用这一份 */
const POLITE = '^\\s*(?:请\\s*)?(?:帮我\\s*)?';
const POLITE_HEAD = new RegExp(POLITE);
const alt = (ps: readonly Phrase[], pick: (p: Phrase) => boolean): string =>
  ps.filter(pick).map((p) => (p.when === undefined ? p.word : `${p.word}(?=${p.when})`)).join('|');
const HIT: Readonly<Record<QueryKind, RegExp>> = {
  search: new RegExp(alt(PHRASES.search, (p) => p.hit !== false)),
  summary: new RegExp(alt(PHRASES.summary, () => true)),
  list: new RegExp(alt(PHRASES.list, () => true)),
  conflict: new RegExp(alt(PHRASES.conflict, () => true)),
};
/** 祈使位置的正则：没有这种位置的说法时不生成；tailMark 是句尾说法后面许带的一个标点 */
function imperativeRes(ps: readonly Phrase[], tailMark: string): RegExp[] {
  const at = (pos: Pos) => alt(ps, (p) => p.pos === pos);
  const shapes: [string, (w: string) => string][] = [
    [at('head'), (w) => `${POLITE}(?:${w})`],
    [at('tail'), (w) => `(?:${w})\\s*${tailMark}?\\s*$`],
    [at('ask'), (w) => `(?:${w})[^?？]*[?？]\\s*$`],
  ];
  return shapes.filter(([w]) => w !== '').map(([w, f]) => new RegExp(f(w)));
}
/** 总结的句尾不收问号：句尾带问号的先命中查找的“[?？]”，走不到总结 */
const IMPERATIVE = { search: imperativeRes(PHRASES.search, '[?？.。!！]'), summarize: imperativeRes(PHRASES.summary, '[.。!！]') };
/** 查询文字里去掉的句式本身（四张表的全部说法） */
const QUERY_STRIP = new RegExp(Object.values(PHRASES).flatMap((ps) => ps.map((p) => p.word)).join('|'), 'g');
/** 日期解析认不出的时间说法：还在句子里就没把握，免得拿“上周”当关键词查 */
const TIME_LEFT_RE = /上周|上个?月|上礼拜|上星期|去年|今年|明年|最近|近期|这几天|月初|月中|月末|月底|周末|年初|年底|지난\s*주|지난\s*달|저번\s*주|요즘|최근|주말|월초|월말|달\s*초|작년|올해|내년/;
/** 事由后面又跟了一个动作（“搜一下资料写报告”“汇总一下报销单交财务”）：像是要记的事 */
const ACTION_AFTER = /\S\s*(?:写|交|发给|发到|发送|提交|上传|打印|准备|寄|送|转给)/;
const ZH_WEEK = new RegExp(`(${ZH_WEEK_PREFIX})\\s*个?\\s*(?:周|星期|礼拜)(?![1-7])`);
const KO_WEEK_RE = new RegExp(`(${KO_WEEK})`);
const ZH_MONTH = /(下|这|本)\s*个?\s*月/;
const KO_MONTH = /(다음|이번)\s*달/;
/** 句式表外、像是取消 / 改期 / 完成的词：意图仍是记下，但没把握（交给 AI 或先保存再提示，不当成有把握的新条目） */
const SUSPECT_RE = /取消|推迟|延期|延后|改期|变更|변경|연기|미뤄|미루|标完成|标为完成|완료/;

type Range = NonNullable<PlusQuery['range']>;

/** 单日、整周（周一起始）、整月；认不出返回 null */
function takeRange(st: Rest, today: DateStr): Range | null {
  const d = takeDate(st, today);
  if (d?.ok) return { from: d.date, to: d.date };
  const w = take(st, ZH_WEEK) ?? take(st, KO_WEEK_RE);
  if (w) {
    const mon = weekday(today, weekPrefix(w[1] ?? ''), 1);
    return { from: mon, to: addDays(mon, 6) };
  }
  const m = take(st, ZH_MONTH) ?? take(st, KO_MONTH);
  if (!m) return null;
  const ym = shiftMonth(monthOf(today), m[1] === '下' || m[1] === '다음' ? 1 : 0);
  return { from: firstOfMonth(ym), to: lastOfMonth(ym) };
}

/** 两段文字从头起相同的那一段（取走日子以后，看日子前面有没有别的字） */
function commonHead(a: string, b: string): string {
  let i = 0;
  while (i < a.length && a.at(i) === b.at(i)) i++;
  return a.slice(0, i);
}

type Hits = Record<QueryKind, boolean> & { overdue: boolean };

/**
 * 查找、总结的 query；rest 是取完以后剩下的字（看还有没有认不出的日子、时刻）；recordLike：日子前面已经有事由，或事由后面还有动作。
 * 先去掉句式本身，免得“一下下周”读成“下下周”；“今天 X 没完成的”留下 X 当关键词。
 */
function buildQuery(pre: string, h: Hits, today: DateStr): { query: PlusQuery; rest: string; recordLike: boolean } {
  const st: Rest = { text: ' ' + pre.replace(QUERY_STRIP, ' ').replace(POLITE_HEAD, '') + ' ' };
  const od = h.overdue && takeOverdue(st);
  const before = st.text;
  const range = od ? { from: null, to: today } : takeRange(st, today);
  const lateDate = !od && range !== null && commonHead(before, st.text).trim() !== '';
  takePeriodOnly(st);
  const named = takeKindWords(st);
  const said: IntentKind[] = [...(named.event ? ['event' as const] : []), ...(named.todo ? ['todo' as const] : []), ...(named.note ? ['note' as const] : [])];
  const kinds: IntentKind[] = od ? ['todo'] : h.conflict ? ['event'] : said.length > 0 ? said : [...INTENT_KINDS];
  const query: PlusQuery = { text: cutGraphemes(cleanTitle(st.text), QUERY_TEXT_MAX), range, kinds, done: od ? 'open' : 'any' };
  return { query, rest: st.text, recordLike: lateDate || ACTION_AFTER.test(query.text) };
}

/** 请求说法、点名说法去不掉任何东西（“提醒我明天查一下快递”是两边都沾） */
function untouched(pre: string): boolean {
  const st: Rest = { text: pre };
  takeNamedKind(st);
  stripRequests(st);
  return st.text === pre;
}

/**
 * 查找、总结有没有把握：下面全满足才算，哪条不满足都交给 AI（离线先按记下保存，不丢记录）。
 * ① 只说了这一种说法（查找时没有总结、列出、冲突）；② 说法在祈使位置；③ 不像要记的事（recordLike）；
 * ④ 没有批量词、相关待办、“今天没完成的”（extra、overdue）；⑤ 请求说法、点名说法去不掉任何东西；
 * ⑥ 没有认不出的时间说法（原话里的 TIME_LEFT_RE、取完以后剩下的 LEFTOVER_RE）。原话超长另由调用方判。
 *   TIME_LEFT_RE 要测原话、不能测剩下的：“下个月初”里的“下个月”会被取走，剩下“初”就认不出“月初”了（intent.test“还有没认出的时间说法”）。
 */
function sureQuery(intent: 'search' | 'summarize', pre: string, h: Hits, extra: boolean, built: { rest: string; recordLike: boolean }): boolean {
  const only = intent === 'search' ? !h.summary && !h.list && !h.conflict : true;
  const imperative = (intent === 'search' ? IMPERATIVE.search : IMPERATIVE.summarize).some((re) => re.test(pre));
  return only && imperative && !built.recordLike && !extra && !h.overdue && untouched(pre) && !TIME_LEFT_RE.test(pre) && !LEFTOVER_RE.test(built.rest);
}

const none = { query: null, target: null, to: null, bulkRefused: false, relatedTodos: false };

export function localIntent(text: string, now: number, tz: Tz, opts: IntentOpts = {}): LocalIntent {
  const raw = String(text);
  const short = raw.length <= QUICK_MAX;
  const today = todayOf(now, tz);
  const pre = prepare(raw);
  const related = RELATED_RE.test(pre);
  const targetIntent = targetIntentOf(pre);
  if (targetIntent !== null) {
    const r = opts.scope === 'vault' ? null : takeTarget(targetIntent, pre, today);
    if (r === null) return { intent: 'record', sure: false, ...none };
    return { intent: targetIntent, sure: false, query: null, target: r.target, to: r.to, bulkRefused: r.bulkRefused, relatedTodos: targetIntent === 'cancel' && related };
  }
  const h: Hits = { search: HIT.search.test(pre), summary: HIT.summary.test(pre), list: HIT.list.test(pre), conflict: HIT.conflict.test(pre), overdue: saysOverdue(pre) };
  const extra = BULK_RE.test(pre) || related;
  const intent = h.conflict || h.list || h.search ? 'search' : h.summary ? 'summarize' : 'record';
  if (intent === 'record') return { intent, sure: short && !extra && !h.overdue && !SUSPECT_RE.test(pre), ...none };
  const built = buildQuery(pre, h, today);
  return { intent, sure: short && sureQuery(intent, pre, h, extra, built), ...none, query: built.query };
}
