// i18n-exempt: 解析词表
// “＋”打字的本机意图规则 localIntent（架构 5.14 第 2 点）：记下、查找、总结、取消、改期、完成，并解析出 query 或 target、to。
// 不变量：句式表照 5.14 原文；查找、总结只有说在祈使位置、原话没有别的说法、没有认不出的时间词、也不像要记的事（日子跟在事由后面、事由后面还有别的动作）时才有把握，其余命中一律没把握（不丢记录）；记下遇到句式表外的疑似取消 / 改期 / 完成词也没把握。
// 改期：中文在说法处一分为二，韩文“…로 미뤄”取紧挨“로”前面、能整段解析成日子或时刻的最长一段当 to；target 最后过 resolveTarget。
// 纯函数：now、tz 由调用方传入，不读时钟、不写日志。
import { addDays, todayOf, type DateStr } from '../../core/date.ts';
import type { Tz } from '../../core/tz.ts';
import { INTENT_KINDS, type IntentKind } from '../../schema/kinds.ts';
import { firstOfMonth, lastOfMonth, monthOf, shiftMonth } from '../calendar/cal-nav.ts';
import { cutGraphemes } from '../short.ts';
import { KO_WEEK, takeDateKo, takeDateZh, weekday, weekPrefix, ZH_WEEK_PREFIX } from './date-words.ts';
import { cleanTitle, stripRequests, takeKindWords, takeNamedKind } from './marks.ts';
import { LEFTOVER_RE } from './parse-split.ts';
import { resolveTarget, type PlusTarget, type TargetIntent, type TargetKind } from './resolve-target.ts';
import { prepare, QUICK_MAX, take, type Rest } from './text.ts';
import { takePeriodOnly, takeTime } from './time-words.ts';
/** “＋”的意图（B4b-3 放开 shared/schema/ai.ts 的 INTENTS 时引用这一份） */
export const PLUS_INTENTS = ['record', 'search', 'summarize', 'cancel', 'reschedule', 'complete'] as const;
export type PlusIntent = (typeof PLUS_INTENTS)[number];
export type QueryDone = 'open' | 'done' | 'any';
export interface PlusQuery {
  text: string;
  /** from 为 null：截止到 to 为止（只配 kinds [todo]、done open） */
  range: { from: DateStr | null; to: DateStr } | null;
  kinds: IntentKind[];
  done: QueryDone;
}
/** 改期改到哪天几点（只说时刻的 date 为 null，日子不变） */
export interface PlusTo {
  date: DateStr | null;
  time: string | null;
}
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

const SEARCH_RE = /帮我找|搜一下|查一下|看一下.*有什么|찾아\s*줘|뭐\s*있어|[?？]\s*$/;
const SUMMARY_RE = /总结|汇总|정리해\s*줘/;
const LIST_RE = /列出|列一下|给我看|显示|有哪些|보여\s*줘|목록|있는지\s*확인해\s*줘|뭐\s*있는지\s*알려\s*줘/;
const CONFLICT_RE = /冲突|撞了|重叠|겹치/;
/** 祈使位置：句首“帮我找 / 总结……”、句尾“…찾아 줘 / 정리해 줘”、“…有什么…？”；名词用法（“交季度总结”）不在这里；句首的名词用法（“总结报告周五交”）由 buildQuery 的 recordLike 拦 */
const SURE_SEARCH = [/^\s*(?:请\s*)?(?:帮我找|搜一下|查一下)/, /^\s*(?:请\s*)?看一下.*有什么/, /(?:찾아\s*줘|뭐\s*있어)\s*[?？.。!！]?\s*$/, /有什么[^?？]*[?？]\s*$/];
const SURE_SUMMARY = [/^\s*(?:请\s*)?(?:帮我)?\s*(?:总结|汇总)/, /정리해\s*줘\s*[.。!！]?\s*$/];
/** 日期解析认不出的时间说法：还在句子里就没把握，免得拿“上周”当关键词查 */
const TIME_LEFT_RE = /上周|上个?月|上礼拜|上星期|去年|今年|明年|最近|近期|这几天|月初|月中|月末|月底|周末|年初|年底|지난\s*주|지난\s*달|저번\s*주|요즘|최근|주말|월초|월말|달\s*초|작년|올해|내년/;
/** 查询文字里去掉的句式本身 */
const QUERY_STRIP = /帮我找(?:一下)?|搜一下|查一下|看一下|有什么|찾아\s*줘|뭐\s*있어|[?？]|(?:总结|汇总)(?:一下)?|정리해\s*줘|列出|列一下|给我看看?|显示|有哪些|보여\s*줘|목록|있는지\s*확인해\s*줘|뭐\s*있는지\s*알려\s*줘|冲突|撞了|重叠|겹치\S*/g;
/** 去掉句式以后句首剩下的客气话（“请帮我总结一下……”） */
const POLITE_HEAD = /^\s*(?:请\s*)?(?:帮我\s*)?/;
/** 事由后面又跟了一个动作（“搜一下资料写报告”“汇总一下报销单交财务”）：像是要记的事 */
const ACTION_AFTER = /\S\s*(?:写|交|发给|发到|发送|提交|上传|打印|准备|寄|送|转给)/;
const NOTE_WORD = /随手记|메모/g;
const ZH_WEEK = new RegExp(`(${ZH_WEEK_PREFIX})\\s*个?\\s*(?:周|星期|礼拜)(?![1-7])`);
const KO_WEEK_RE = new RegExp(`(${KO_WEEK})`);
const ZH_MONTH = /(下|这|本)\s*个?\s*月/;
const KO_MONTH = /(다음|이번)\s*달/;
const QUERY_TEXT_MAX = 100;
/** 取消、改期、完成的句式 */
const COMPLETE_RE = /标记为已?完成|标成完成|打个?勾|打钩|勾掉|做完了|搞定了|완료로\s*표시|완료\s*처리|체크해\s*줘/;
const CANCEL_RE = /取消了|不去了|不开了|취소|안\s*가(?![가-힣])/;
const RESCHEDULE_ZH = /改到|推到|挪到|延到/;
const RESCHEDULE_KO = /로\s*(?:바꿔|미뤄|옮겨)/;
const RESCHEDULE_RE = new RegExp(`${RESCHEDULE_ZH.source}|${RESCHEDULE_KO.source}`);
/** 句式表外、像是取消 / 改期 / 完成的词：意图仍是记下，但没把握（交给 AI 或先保存再提示，不当成有把握的新条目） */
const SUSPECT_RE = /取消|推迟|延期|延后|改期|变更|변경|연기|미뤄|미루|标完成|标为完成|완료/;
/** 取消、改期、完成的说法（任一种） */
const TARGET_PHRASE = `${RESCHEDULE_RE.source}|${CANCEL_RE.source}|${COMPLETE_RE.source}`;
/** 批量词：“다”只认独立成词的（不认“다음”）；“都”只认紧挨取消、改期、完成说法的（不认“首都”） */
const BULK_WORD = /全部|所有|모두|전부|(?<![가-힣])다(?![가-힣])/;
const BULK_RE = new RegExp(`${BULK_WORD.source}|都\\s*(?:${TARGET_PHRASE})`);
const RELATED_RE = /相关的?待办|有关的待办|관련된?\s*할\s*일/;
/** “今天 / 오늘”后面 12 个字以内（不跨标点）说了没完成：中间可以隔字（“今天所有未完成”）；后面的“的”一起取走（“今天采购没完成的”） */
const OVERDUE_RE = /(今天|오늘)([^，。,.!?！？；;:：]{0,12}?)(?:没完成|未完成|没做完|还没做|완료하지\s*(?:않은|못\s*한)|못\s*한|(?:아직\s*)?안\s*끝난|미완료)的?/;
const DEMONSTRATIVE = /这个|那个|这件事|那件事|这件|那件|这条|那条|这项|那项/g;
const CLAUSE = /[，,。.;；!！?？]/;
/** 连接词：“相关待办”前面的（“…和相关待办”）、后面的（“相关待办和明天的会”）都用这一份 */
const LINK = '顺便|并且|而且|同时|还有|以及|和|跟|及|하고|그리고|랑|및';
/** “相关待办”那一段从哪儿起：紧挨在前面的标点或连接词，中间可以隔“把 / 所有” */
const RELATED_LEAD = new RegExp(`(?:${CLAUSE.source}|${LINK})\\s*(?:把|将)?\\s*(?:所有|全部|모든)?\\s*$`);
/** 紧跟在“相关待办”后面的连接词（韩文可带“이”）：连它一起去掉，后面是原条目 */
const RELATED_LINK = new RegExp(`^\\s*(?:이)?(?:${LINK})`);
/** 不然“相关待办”那一段到标点或取消、改期、完成说法为止（说法留给 cutPhrase、splitReschedule） */
const RELATED_END = new RegExp(`${CLAUSE.source}|${TARGET_PHRASE}`);
/** target.text 最长多少（架构 5.14 第 7 点的输出结构） */
const TARGET_TEXT_MAX = 60;

type Range = NonNullable<PlusQuery['range']>;

/** 单日、整周（周一起始）、整月；认不出返回 null */
function takeRange(st: Rest, today: DateStr): Range | null {
  const d = takeDateKo(st, today) ?? takeDateZh(st, today);
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
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(0, i);
}

interface Hits {
  search: boolean;
  summary: boolean;
  list: boolean;
  conflict: boolean;
  overdue: boolean;
}

/**
 * 查找、总结的 query；rest 是取完以后剩下的字（看还有没有认不出的日子、时刻）；recordLike：日子前面已经有事由，或事由后面还有动作。
 * 先去掉句式本身，免得“一下下周”读成“下下周”。
 */
function buildQuery(pre: string, h: Hits, today: DateStr): { query: PlusQuery; rest: string; recordLike: boolean } {
  const st: Rest = { text: ' ' + pre.replace(QUERY_STRIP, ' ').replace(POLITE_HEAD, '') + ' ' };
  const od = h.overdue ? take(st, OVERDUE_RE) : null;
  const before = st.text;
  const range = od ? { from: null, to: today } : takeRange(st, today);
  const lateDate = !od && range !== null && commonHead(before, st.text).trim() !== '';
  takePeriodOnly(st);
  const named = takeKindWords(st);
  const noNote = st.text.replace(NOTE_WORD, ' ');
  const note = noNote !== st.text;
  st.text = noNote;
  const said: IntentKind[] = [...(named.event ? ['event' as const] : []), ...(named.todo ? ['todo' as const] : []), ...(note ? ['note' as const] : [])];
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

interface TargetParse {
  target: PlusTarget;
  /** 只有改期才有 */
  to: PlusTo | null;
  bulkRefused: boolean;
}

/** 取走日子（fixed 不为 null 时不取、就用它）和按日子时段取的时刻；“晚上12点”进一天；没时刻时去掉单独的时段词 */
function takeWhen(st: Rest, today: DateStr, fixed: DateStr | null = null): PlusTo {
  const d = fixed === null ? (takeDateKo(st, today) ?? takeDateZh(st, today)) : null;
  const tm = takeTime(st, d?.ok ? d.period : '');
  if (!tm) takePeriodOnly(st);
  const date = fixed ?? (d?.ok ? d.date : null);
  return { date: tm?.nextDay ? addDays(date ?? today, 1) : date, time: tm ? tm.time : null };
}

/** 改期的 to；whole 时整段都要能解析掉（韩文 to 用），解析不出日子也解析不出时刻返回 null */
function parseWhen(s: string, today: DateStr, whole: boolean): PlusTo | null {
  const st: Rest = { text: ' ' + s + ' ' };
  const to = takeWhen(st, today);
  if (whole && st.text.trim() !== '') return null;
  return to.date === null && to.time === null ? null : to;
}

/** 韩文：“로”前面从最长的一段试起，整段是日子或时刻的就是 to，前面的是 target */
function splitKo(before: string, today: DateStr): { head: string; to: PlusTo } | null {
  const starts = [0, ...[...before.matchAll(/\s+/g)].map((m) => (m.index ?? 0) + m[0].length)];
  for (const i of starts) {
    const to = parseWhen(before.slice(i), today, true);
    if (to) return { head: before.slice(0, i), to };
  }
  return null;
}

/** 去掉取消、完成的说法，说了几处去几处（“…取消了，相关待办也取消了”）；韩文连同这个词剩下的部分和“줘”（“취소됐어”“완료 처리해 줘”）；紧挨在前面的“都”一起去掉 */
function cutPhrase(text: string, re: RegExp): string {
  let s = text;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    let end = m.index + m[0].length;
    if (/[가-힣]$/.test(m[0])) end += /^[가-힣]*(?:\s*(?:줘|주세요))?/.exec(s.slice(end))?.[0].length ?? 0;
    s = s.slice(0, m.index).replace(/都\s*$/, '') + ' ' + s.slice(end);
  }
  return s;
}

function parseHead(intent: TargetIntent, head: string, today: DateStr, bulk: boolean): PlusTarget {
  const st: Rest = { text: ' ' + head + ' ' };
  const od = OVERDUE_RE.exec(st.text);
  if (od) st.text = st.text.replace(od[0], ` ${od[2] ?? ''} `);
  const { date, time } = takeWhen(st, today, od ? today : null);
  st.text = st.text.replace(new RegExp(BULK_WORD.source, 'g'), ' ').replace(DEMONSTRATIVE, ' ');
  const named = takeKindWords(st);
  const kinds: TargetKind[] =
    intent === 'complete' || od ? ['todo'] : named.todo === named.event ? ['event', 'todo'] : named.todo ? ['todo'] : ['event'];
  const text = cutGraphemes(cleanTitle(st.text.replace(/^\s*把/, ' ')), TARGET_TEXT_MAX);
  return { text, date, time, kinds, ...(od ? { with_overdue: true } : {}), ...(bulk ? { all: true } : {}) };
}

/** 改期：中文在说法处一分为二，韩文按“로”前面的最长一段；取不出 to 返回 null */
function splitReschedule(body: string, today: DateStr): { head: string; to: PlusTo } | null {
  const zh = RESCHEDULE_ZH.exec(body);
  if (zh) {
    const to = parseWhen(body.slice(zh.index + zh[0].length), today, false);
    return to ? { head: body.slice(0, zh.index).replace(/都\s*$/, ''), to } : null;
  }
  const ko = RESCHEDULE_KO.exec(body);
  return ko ? splitKo(body.slice(0, ko.index), today) : null;
}

/**
 * 去掉“相关待办”那一段：从紧挨在前面的标点或连接词起（都没有就从这一句开头起）；
 * 后面紧跟连接词的到连接词为止（“相关待办和明天的会…”），不然到这一句末尾、标点或后面的取消、改期、完成说法。
 */
function dropRelated(text: string): string {
  const m = RELATED_RE.exec(text);
  if (!m) return text;
  const before = text.slice(0, m.index);
  const lead = RELATED_LEAD.exec(before);
  const start = lead ? lead.index : Math.max(0, ...[...before.matchAll(new RegExp(CLAUSE.source, 'g'))].map((c) => (c.index ?? 0) + 1));
  const after = text.slice(m.index + m[0].length);
  const link = RELATED_LINK.exec(after);
  const end = link ? link[0].length : after.search(RELATED_END);
  return before.slice(0, start) + ' ' + (end < 0 ? '' : after.slice(end));
}

/** 取 target、to；改期取不出日子也取不出时刻时返回 null（按记下处理） */
function takeTarget(intent: TargetIntent, text: string, today: DateStr): TargetParse | null {
  const body = dropRelated(text);
  const bulk = BULK_RE.test(body);
  const split = intent === 'reschedule' ? splitReschedule(body, today) : { head: cutPhrase(body, intent === 'cancel' ? CANCEL_RE : COMPLETE_RE), to: null };
  if (split === null) return null;
  const { target, bulkRefused } = resolveTarget(intent, parseHead(intent, split.head, today, bulk));
  return { target, to: split.to, bulkRefused };
}

const none = { query: null, target: null, to: null, bulkRefused: false, relatedTodos: false };

export function localIntent(text: string, now: number, tz: Tz, opts: IntentOpts = {}): LocalIntent {
  const raw = String(text);
  const short = raw.length <= QUICK_MAX;
  const today = todayOf(now, tz);
  const pre = prepare(raw);
  const related = RELATED_RE.test(pre);
  const targetIntent: TargetIntent | null = RESCHEDULE_RE.test(pre) ? 'reschedule' : CANCEL_RE.test(pre) ? 'cancel' : COMPLETE_RE.test(pre) ? 'complete' : null;
  if (targetIntent !== null) {
    const r = opts.scope === 'vault' ? null : takeTarget(targetIntent, pre, today);
    if (r === null) return { intent: 'record', sure: false, ...none };
    return { intent: targetIntent, sure: false, query: null, target: r.target, to: r.to, bulkRefused: r.bulkRefused, relatedTodos: targetIntent === 'cancel' && related };
  }
  const h: Hits = { search: SEARCH_RE.test(pre), summary: SUMMARY_RE.test(pre), list: LIST_RE.test(pre), conflict: CONFLICT_RE.test(pre), overdue: OVERDUE_RE.test(pre) };
  const extra = BULK_RE.test(pre) || related;
  const intent = h.conflict || h.list || h.search ? 'search' : h.summary ? 'summarize' : 'record';
  if (intent === 'record') return { intent, sure: short && !extra && !h.overdue && !SUSPECT_RE.test(pre), ...none };
  const { query, rest, recordLike } = buildQuery(pre, h, today);
  const only = intent === 'search' ? !h.summary && !h.list && !h.conflict : true;
  const imperative = (intent === 'search' ? SURE_SEARCH : SURE_SUMMARY).some((re) => re.test(pre));
  const sure = short && only && imperative && !recordLike && !extra && !h.overdue && untouched(pre) && !TIME_LEFT_RE.test(pre) && !LEFTOVER_RE.test(rest);
  return { intent, sure, ...none, query };
}
