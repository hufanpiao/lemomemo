// i18n-exempt: 解析词表
// “＋”取消、改期、完成的本机解析（架构 5.14 第 2、7 点）：认说法（targetIntentOf），取 target、to（takeTarget）；“今天 X 没完成的”（takeOverdue）查找也用这一个。
// 改期：中文在说法处一分为二，韩文“…로 미뤄”取紧挨“로”前面、能整段解析成日子或时刻的最长一段当 to；target 最后过 resolveTarget。
// 纯函数：today 由调用方按 now、tz 算好传入。
import { addDays, type DateStr } from '../../core/date.ts';
import { cutGraphemes } from '../short.ts';
import { takeDate } from './date-words.ts';
import { cleanTitle, takeKindWords } from './marks.ts';
import { resolveTarget, type PlusTarget, type TargetIntent, type TargetKind } from './resolve-target.ts';
import type { Rest } from './text.ts';
import { TARGET_TEXT_MAX, type PlusTo } from '../../schema/intent.ts';
import { takePeriodOnly, takeTime } from './time-words.ts';

/** 改期改到哪天几点：类型定义在 shared/schema/intent.ts，这里转出给老调用方 */
export type { PlusTo } from '../../schema/intent.ts';

const COMPLETE_RE = /标记为已?完成|标成完成|打个?勾|打钩|勾掉|做完了|搞定了|완료로\s*표시|완료\s*처리|체크해\s*줘/;
/** 韩文“안 가”：单说，或带“가다”的词尾（안 가요、안 가기로 했어、안 가게 됐어、안 가겠어、안 가려고 해），以及 안 갈래、안 갈게、안 갈 거야、안 갑니다；
 *  “안 가져”“안 가방”“안 갈아입어”这类“가 / 갈”开头的别的词不算（只收列出的词尾） */
const KO_NOT_GO = '안\\s*(?:가(?:(?:요|기로|게|겠|려고)[가-힣]*(?:\\s*(?:했|됐|해)[가-힣]*)?)?|갈(?:래|게)[가-힣]*|갈\\s*거[가-힣]*|갑니다)(?![가-힣])';
const CANCEL_RE = new RegExp(`取消了|不去了|不开了|취소|${KO_NOT_GO}`);
const RESCHEDULE_ZH = /改到|推到|挪到|延到/;
const RESCHEDULE_KO = /로\s*(?:바꿔|미뤄|옮겨)/;
const RESCHEDULE_RE = new RegExp(`${RESCHEDULE_ZH.source}|${RESCHEDULE_KO.source}`);
/** 取消、改期、完成的说法（任一种） */
const TARGET_PHRASE = `${RESCHEDULE_RE.source}|${CANCEL_RE.source}|${COMPLETE_RE.source}`;
/** 批量词：“다”只认独立成词的（不认“다음”）；“都”只认紧挨取消、改期、完成说法的（不认“首都”） */
const BULK_WORD = /全部|所有|모두|전부|(?<![가-힣])다(?![가-힣])/;
const BULK_WORDS = new RegExp(BULK_WORD.source, 'g');
export const BULK_RE = new RegExp(`${BULK_WORD.source}|都\\s*(?:${TARGET_PHRASE})`);
/** 说法前面紧挨的“都”（“明天的会都取消了”）：去说法时一起去掉 */
const DOU_TAIL = /都\s*$/;
export const RELATED_RE = /相关的?待办|有关的待办|관련된?\s*할\s*일/;
/** “今天 / 오늘”后面 12 个字以内（不跨标点）说了没完成：中间可以隔字（“今天所有未完成”“今天采购没完成的”）；后面的“的”一起取走 */
const OVERDUE_RE =
  /(今天|오늘)([^，。,.!?！？；;:：]{0,12}?)(?:(?:还\s*)?(?:没完成|未完成|没做完)|还没做|완료하지\s*(?:않은|못\s*한)|못\s*한|(?:아직\s*)?안\s*끝난|미완료)的?/;
/** 中间那段里不是关键词的字（“今天所有没完成的”“오늘 할 일 중에서 아직 완료하지 않은”） */
const OVERDUE_FILLER = /所有|全部|모든|아직|중에서/g;
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

/** 原话说的是改期、取消还是完成（同时说了几种时按这个先后）；都不是返回 null */
export function targetIntentOf(pre: string): TargetIntent | null {
  return RESCHEDULE_RE.test(pre) ? 'reschedule' : CANCEL_RE.test(pre) ? 'cancel' : COMPLETE_RE.test(pre) ? 'complete' : null;
}

/** 原话有没有说“今天 X 没完成的” */
export const saysOverdue = (s: string): boolean => OVERDUE_RE.test(s);

/** 取走“今天 X 没完成的”，中间的 X 留下当关键词（去掉“所有 / 아직”这类字）；没说返回 false。查找和取消、改期、完成共用 */
export function takeOverdue(st: Rest): boolean {
  const od = OVERDUE_RE.exec(st.text);
  if (!od) return false;
  st.text = st.text.replace(od[0], ` ${(od[2] ?? '').replace(OVERDUE_FILLER, ' ')} `);
  return true;
}

/** 取走日子（fixed 不为 null 时不取、就用它）和按日子时段取的时刻；“晚上12点”进一天；没时刻时去掉单独的时段词 */
function takeWhen(st: Rest, today: DateStr, fixed: DateStr | null = null): PlusTo {
  const d = fixed === null ? takeDate(st, today) : null;
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
    s = s.slice(0, m.index).replace(DOU_TAIL, '') + ' ' + s.slice(end);
  }
  return s;
}

function parseHead(intent: TargetIntent, head: string, today: DateStr, bulk: boolean): PlusTarget {
  const st: Rest = { text: ' ' + head + ' ' };
  const od = takeOverdue(st);
  const { date, time } = takeWhen(st, today, od ? today : null);
  st.text = st.text.replace(BULK_WORDS, ' ').replace(DEMONSTRATIVE, ' ');
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
    return to ? { head: body.slice(0, zh.index).replace(DOU_TAIL, ''), to } : null;
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

export interface TargetParse {
  target: PlusTarget;
  /** 只有改期才有 */
  to: PlusTo | null;
  bulkRefused: boolean;
}

/** 取 target、to；改期取不出日子也取不出时刻时返回 null（按记下处理） */
export function takeTarget(intent: TargetIntent, text: string, today: DateStr): TargetParse | null {
  const body = dropRelated(text);
  const bulk = BULK_RE.test(body);
  const split = intent === 'reschedule' ? splitReschedule(body, today) : { head: cutPhrase(body, intent === 'cancel' ? CANCEL_RE : COMPLETE_RE), to: null };
  if (split === null) return null;
  const { target, bulkRefused } = resolveTarget(intent, parseHead(intent, split.head, today, bulk));
  return { target, to: split.to, bulkRefused };
}
