// i18n-exempt: 解析词表
// 本机规则（B 路）入口：parseSplit、confidence（B3 任务单 S7、S9、BE-2、接口先定第 3 条；架构 5.1、第 7 节；R-54、R-163、R-165、R-166、
// R-182、R-183、R-195、R-200；移植 v3 parse-quick.js）。打字和 Web Speech 兜底得到的文字先走这里：
//   • 有把握（confidence = 'sure'，R-54）：只拆出 1 件、日期能识别、类型明确 → 直接用本机结果，不调 AI、不扣次数；
//     带重复说法、要先问日子（confirm）、有不存在的日子、像纪念日或随手记、句子过长的一律“没把握”，在线、有同意、有额度时交给 AI；
//   • 输出和 AI 校验后的结构相同（shared/schema/ai.ts 的 AiItem，含 confirm，由 past-date.ts 的 pastDate 算），
//     保存一侧统一走 shared/logic/capture-map.ts。
// 步骤：预处理 → 点名类型（整句）→ 去请求说法（整句）→ 拆分 → 每段：重复说法 → 日期（韩文、中文）→ 中文相对时刻（R-374）→ 时刻 → 时段词 → 重要 → 项目 → 标题。
//   同一句后一件没说日子的沿用前一件的日子和 basis（照抄，第 7 节 0.29 续第 67 条），也沿用前一件写明的时段词（“周四上午九点看牙，十一点对账”）。
// 纪念日：只有生日、纪念日（结婚、恋爱、周年、기념일、주년）、倒数日的说法才记纪念日（0.29 续第 151 条），而且 features 里有 anniv 才记；
//   没打开（B5 之前）就记成待办。随手记本机规则不出（写入路径 B4），像随手记的只记“没把握”。
// B3 任务单补充（11-07 架构师）：R5 没说日子、时刻今天已过照样记今天（凌晨 / 새벽例外记明天）；R6 opts.defaultDay（日历页选中的那天）只对
//   没说日子的条目生效（补出来的日子不算认出了日子，照旧判没把握，R9）；R8 只用空格隔开的“时刻 + 事 + 时段词 + 事”不拆、记 leftover 判没把握。
// 纯函数：“现在”由 now（毫秒）和 tz 传入，不读时钟、不碰本地时区；locale 只留作接口（中韩说法两边都认，混说不看界面语言）。
import { addDays, minOfDay, todayOf, type DateStr } from '../../core/date.ts';
import type { Tz } from '../../core/tz.ts';
import type { AiItem } from '../../schema/ai.ts';
import type { AiKind } from '../../schema/kinds.ts';
import { takeDateKo, takeDateZh, type DateHit } from './date-words.ts';
import { arrangeHint, cleanTitle, findProject, stripRequests, takeImportant, takeNamedKind, type NamedKind } from './marks.ts';
import { cutGraphemes } from '../short.ts';
import { pastDate, type DateBasis } from './past-date.ts';
import { RECUR_MARK, recurHint, takeRecur } from './recur-hint.ts';
import { splitClauses } from './split.ts';
import { pad2, prepare, QUICK_MAX, restoreWeekdays, type Rest } from './text.ts';
import { periodLeft, takePeriodOnly, takeRelative, takeTime } from './time-words.ts';

/** 标题最长多少（UTF-16 单元，同 shared/schema/rows.ts 的 events / todos.title max(160)） */
const TITLE_MAX = 160;

/** 提示条要用的几样（客户端按它选文案） */
export interface ParseHints {
  /** 原话有重复说法：“重复要等新版本，这次只记了最近一次”（R-163） */
  recur: boolean;
  /** 原话有“安排时间 / 排一下时间 / 시간 잡아 / 일정 짜”：“具体时间请自己排”（R-200） */
  arrange: boolean;
  /** 月份本来就没有的日子（“11月31号”）：不认成日子、日期留空，提示“11 月没有 31 日”（R-166，续第 68 条） */
  bad_day: { month: number; day: number } | null;
}

/** 没把握的原因（调试和单测看；客户端只看 confidence） */
export type Doubt = 'multi' | 'no_date' | 'recur' | 'confirm' | 'bad_day' | 'anniv' | 'note' | 'too_long' | 'empty' | 'leftover' | 'rel_conflict';

export interface ParseResult {
  items: AiItem[];
  hints: ParseHints;
  doubts: Doubt[];
}

export interface ParseOpts {
  /** 这个人能用的类型（featureOn 算好的）；默认只有 event、todo（B3 预览全局只开这两种，任务单 Q7） */
  features?: readonly AiKind[];
  /** 日历页选中的那天（R-353、R6；YYYY-MM-DD，调用方已校验格式和“前 1 年到后 5 年”）。不传时行为不变（等于今天，连时刻也没有的待办不记日子）。
   *  传了时只对“原话没说日子”的条目生效：只说时刻的日程、只说时刻的待办截止、连时刻也没有的待办和日程都记这一天；
   *  相对说法（明天、下周三、月底）照旧按真实的今天算，date_basis 仍是 rel。
   *  补出来的日子不算“认出了日子”（R9）：原话连时刻时段都没有的照旧记 no_date、判没把握，有没有把握和不传时一样。“凌晨 / 새벽已过记明天”只在这一天就是今天时适用（R5 ④） */
  defaultDay?: DateStr;
}

const ANNIV_RE = /生日|生辰|纪念日|周年|倒数日|기념일|생일|생신|주년|디데이|D-?day/i;
const COUNTDOWN_RE = /倒数日|디데이|D-?day/i;
const BIRTHDAY_RE = /生日|生辰|생일|생신/;
const LUNAR_RE = /农历|阴历|음력/;
const NOTE_RE = /(?:^|\s)(?:想法|灵感|备忘|아이디어|메모)\s*[:：]|说他|听说|한대|간대|했대|이래/;
/** 标题里还剩日期、时刻、星期词（代码审 M3：“到周三出差”“和周五3点开会”“开会和 3点去银行”）：说明一句里还有没认完的日子或时刻，判没把握。
 *  “3号楼”“3号线”这类不算（同 date-words 的排除） */
const LEFTOVER_RE = new RegExp([
  '\\d{1,2}\\s*(?:点|點|시(?![간작])|:\\d{2})',
  '(?<![\\d.第A-Za-z区层栋])\\d{1,2}\\s*[号日](?![楼栋室线院间])',
  '\\d{1,2}\\s*월\\s*\\d{1,2}\\s*일', '\\d{1,2}\\s*일(?![요간])',
  '(?:周|星期|礼拜)[一二三四五六日天]', '[월화수목금토일]요일',
  '今天|明天|后天|大后天|今晚|明早|明晚|오늘|내일|모레|글피',
].join('|'));
/** 没说日子的“凌晨 / 새벽”（代码审 M1）：这个时刻今天已经过了就记明天 */
const EARLY = ['凌晨', '새벽'];

interface Ctx {
  date: DateStr;
  basis: DateBasis;
  period: string;
  /** 这个日子只是默认日子补的（原话没说日子、也没有时刻时段，R9）：沿用它的后一件也算没说日子 */
  soft: boolean;
}

interface Clause {
  item: Omit<AiItem, 'confirm'>;
  ctx: Ctx | null;
}

export function parseSplit(text: string, now: number, tz: Tz, _locale: 'zh' | 'ko', projects: readonly string[], opts: ParseOpts = {}): ParseResult {
  const raw = String(text);
  const features = opts.features ?? ['event', 'todo'];
  const today = todayOf(now, tz);
  const nowMin = minOfDay(now, tz);
  const hints: ParseHints = { recur: recurHint(raw), arrange: arrangeHint(raw), bad_day: null };
  const doubts = new Set<Doubt>();
  if (raw.length > QUICK_MAX) doubts.add('too_long');
  if (hints.recur) doubts.add('recur');

  const st: Rest = { text: ' ' + prepare(raw) + ' ' };
  if (NOTE_RE.test(st.text)) doubts.add('note');
  const named = takeNamedKind(st);
  stripRequests(st);

  const parts = splitClauses(st.text);
  const out: Omit<AiItem, 'confirm'>[] = [];
  let ctx: Ctx | null = null;
  // 只有日子或时刻、没有事由的段并进下一段（代码审 M3：“下周三、周四出差”原来把“下周三”丢了），合起来的那段多出来的日子留在标题里、判没把握
  let carry = '';
  parts.forEach((part, i) => {
    const text = carry ? `${carry} ${part}` : part;
    const env = { today, nowMin, ctx, named, features, projects, hints, doubts, dflt: opts.defaultDay ?? null, sentence: parts.length === 1 ? raw : '', last: i === parts.length - 1 };
    const c = parseClause(text, env);
    if (!c.item.title && c.ctx && i < parts.length - 1) {
      carry = text;
      return;
    }
    carry = '';
    if (c.ctx) ctx = c.ctx;
    if (c.item.title) out.push(c.item);
  });
  if (out.length === 0) {
    // 什么都没剩下（只说了日子、时刻）：原话当标题，没把握
    doubts.add('empty');
    // 按字截（D2）：不把 emoji 截成半个；上限 160 和 rows.ts 的 title 同一口径（UTF-16 单元）
    const title = cutGraphemes(cleanTitle(raw), TITLE_MAX) || cutGraphemes(raw.trim(), TITLE_MAX);
    if (title) out.push(blank(named === 'event' ? 'event' : 'todo', title));
  }
  if (out.length > 1) doubts.add('multi');

  const items: AiItem[] = [];
  for (const it of out.slice(0, 10)) {
    const r = pastDate(it, now, tz);
    if (r.ok) {
      if (r.item.confirm) doubts.add('confirm');
      items.push(r.item);
    } else {
      // 年份写全却不存在（2027年2月29日）、越过“前 1 年后 5 年”：日子留空，没把握
      doubts.add('bad_day');
      items.push({ ...it, date: null, due: null, date_basis: null, confirm: null });
    }
  }
  for (const it of items) {
    if ((it.kind === 'event' && it.date === null) || (it.kind === 'todo' && it.due === null)) doubts.add('no_date');
    if (LEFTOVER_RE.test(it.title)) doubts.add('leftover');
  }
  return { items, hints, doubts: [...doubts] };
}

function blank(kind: AiKind, title: string): Omit<AiItem, 'confirm'> {
  return { kind, title, date: null, time: null, duration_min: null, due: null, important: false, project: null, body: null, short: null, date_basis: null, anniv: null };
}

interface ClauseEnv {
  today: DateStr;
  nowMin: number;
  ctx: Ctx | null;
  named: NamedKind;
  features: readonly AiKind[];
  projects: readonly string[];
  hints: ParseHints;
  doubts: Set<Doubt>;
  /** 调用方传的默认日子（ParseOpts.defaultDay）；没传是 null */
  dflt: DateStr | null;
  /** 只有一段时是原话：纪念日的说法可能被当成请求去掉了（“帮我做个倒数日”“디데이 만들어 줘”），按原话判 */
  sentence: string;
  /** 是最后一段（没有下一段可并） */
  last: boolean;
}

const minOf = (hm: string): number => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

function parseClause(text: string, env: ClauseEnv): Clause {
  const c: Rest = { text: ' ' + text + ' ' };
  const recur = takeRecur(c);
  // 重复说法同一段里的“明天 / 下周一”是开始的日子（代码审建议 1：原来不取，留在标题里、日子记成今天）；每年 M 月 D 日本身带日子，不再取
  const d: DateHit | null = recur?.md ? null : (takeDateKo(c, env.today) ?? takeDateZh(c, env.today));
  if (recur && d?.ok) c.text = c.text.replace(/从\s*开始|从\s*起|(?<=\s)부터/, ' ');
  if (d && !d.ok) {
    env.hints.bad_day ??= d.bad;
    env.doubts.add('bad_day');
  }
  let date: DateStr | null = d?.ok ? d.date : null;
  let basis: DateBasis | null = d?.ok ? d.basis : null;
  let soft = false;
  const hint = d?.ok && d.period ? d.period : !d && env.ctx ? env.ctx.period : '';
  // 中文相对时刻（R-374）：“3分钟后 / 半小时后 / 一个半小时后”按记下那一刻（now）算成日子和时刻，过了午夜就是第二天；
  // 同一段里又说了日期词或具体时刻（“明天半小时后”“半小时后3点开会”）：以相对时刻为准，另外那个从标题去掉，判没把握（rel_conflict，交给 AI）。
  // 带重复说法的不认（重复要从某天起算，相对时刻没有意义）
  const rel = recur ? null : takeRelative(c);
  const said = takeTime(c, hint);
  let tm = said;
  if (rel !== null) {
    if (d || said) env.doubts.add('rel_conflict');
    const at = env.nowMin + rel;
    date = addDays(env.today, Math.floor(at / 1440));
    basis = 'rel';
    tm = { time: pad2(Math.floor((at % 1440) / 60)) + ':' + pad2(at % 60), deadline: false, duration: null, nextDay: false, period: '' };
  }
  // R8：取走一个时刻以后还剩“时段词 + 别的事”（“下午3点开会 晚上看电影”），中间只隔了空格：不拆，判没把握（下一行会把中文时段词从标题去掉，先看）
  if (tm && periodLeft(c.text)) env.doubts.add('leftover');
  const periodOnly = tm ? null : takePeriodOnly(c);
  // 有具体时刻时，另外剩下的中文时段词从标题去掉；韩文的留着（“내일 12시 점심”的점심是事由）。
  // 没有时刻时上一行 takePeriodOnly 中韩都取走（R-165：M28“和老李 점심”记成“和老李”、当天截止的待办；吃饭本身“점심 먹기”留着）
  if (tm) takePeriodOnly(c, false);

  if (recur) {
    // 有开始的日子：从那天起最近的一次（那天当天算，不看现在几点）
    date = d?.ok && d.date > env.today ? recur.next(d.date, -1, null) : recur.next(env.today, env.nowMin, tm ? minOf(tm.time) : null);
    basis = 'rel';
  } else if (date === null && env.ctx && !(d && !d.ok)) {
    date = env.ctx.date;
    basis = env.ctx.basis;
    soft = env.ctx.soft && !tm && !periodOnly;
  }
  // 没说日子时的“那一天”：调用方传了默认日子（日历页选中的，R6）用它，不然是今天
  const base = env.dflt ?? env.today;
  if (tm?.nextDay) {
    date = addDays(date ?? base, 1);
    basis ??= 'rel';
  }
  if (date === null && (tm || periodOnly || (env.dflt !== null && !(d && !d.ok)))) {
    // R9：默认日子补出来的不算“认出了日子”：原话连时刻时段都没有的，照旧记 no_date、判没把握（同一句在今天页、日历页走同一条路）
    soft = !tm && !periodOnly;
    // 只说时刻、只说时段：记那一天（R5 ①：今天的时刻已过也照样记今天，不挪、不问）；
    // 传了默认日子时，连时刻也没有的也记那一天（R6，“买牛奶”记成选中那天的待办）
    date = base;
    basis = 'rel';
    // 唯一例外：没说日子的“凌晨 / 새벽 N 点”今天已经过了，记明天（代码审 M1、R5 ③）；只在那一天就是今天时适用（R5 ④）
    // 截止时刻同样适用（第三轮代码审 M1：R5 ③ 没给截止时刻开例外，23:30 说“凌晨1点前交稿”是明天 01:00 截止）
    if (tm && EARLY.includes(tm.period) && minOf(tm.time) <= env.nowMin && base === env.today) {
      date = addDays(env.today, 1);
    }
  }

  const important = takeImportant(c);
  const project = findProject(c.text, env.projects);
  let title = cutGraphemes(restoreWeekdays(cleanTitle(c.text.replace(RECUR_MARK, recur?.display ?? ''))), TITLE_MAX);
  // “3分钟后提醒我”（R-374）：请求说法去掉以后没有事由了，又是最后一段（前面的段会并进下一段），记成标题“提醒”的日程
  if (!title && rel !== null && env.last) title = '提醒';
  const nextCtx: Ctx | null = date !== null && basis !== null ? { date, basis, period: tm?.period || hint || '', soft } : null;

  // 类型：点名优先（R-195）；像纪念日的（续第 151 条）、有具体时刻的日程、其余待办
  const words = text + ' ' + env.sentence;
  const annivWords = ANNIV_RE.test(words);
  if (annivWords) env.doubts.add('anniv');
  let kind: AiKind = env.named ?? (tm && !tm.deadline ? 'event' : 'todo');
  if (!env.named && annivWords && env.features.includes('anniv') && ((d?.ok && (d.basis === 'md' || d.basis === 'ymd')) || recur?.md)) kind = 'anniv';

  const item = blank(kind, title);
  item.important = important;
  item.project = project || null;
  if (kind === 'anniv') {
    // “每年M月D日是……纪念日”：重复说法本身就是纪念日的意思，不进标题、不记年份
    const md = recur?.md ?? (d?.ok ? { month: Number(d.date.slice(5, 7)), day: Number(d.date.slice(8, 10)) } : { month: 1, day: 1 });
    const y = d?.ok ? Number(d.date.slice(0, 4)) : null;
    const bare = restoreWeekdays(cleanTitle(c.text.replace(RECUR_MARK, ' ')));
    item.title = cleanTitle(cleanTitle(bare.replace(/农历|阴历|음력/g, ' ')).replace(/^(?:是|은|는|이)\s*/, '').replace(/\s*(?:是|은|는)$/, '')) || title;
    item.anniv = {
      type: COUNTDOWN_RE.test(words) ? 'countdown' : BIRTHDAY_RE.test(words) ? 'birthday' : 'anniversary',
      calendar: LUNAR_RE.test(words) ? 'lunar' : 'solar',
      month: md.month,
      day: md.day,
      is_leap: false,
      year: y !== null && !recur && ((d?.ok && d.basis === 'ymd') || COUNTDOWN_RE.test(words)) ? y : null,
    };
    return { item, ctx: nextCtx };
  }
  if (soft) env.doubts.add('no_date');
  if (kind === 'event') {
    item.date = date;
    item.time = tm ? tm.time : null;
    item.duration_min = tm?.duration ?? null;
    item.date_basis = date === null ? null : basis;
  } else {
    item.due = date;
    item.time = tm ? tm.time : null;   // 截止时刻（R-183）；点名待办说了起止的只取开始时刻
    item.date_basis = date === null ? null : basis;
  }
  return { item, ctx: nextCtx };
}

/** R-54“有把握”：只拆出 1 件、日期能识别、类型明确（没有任何“没把握”的原因） */
export function confidence(result: ParseResult): 'sure' | 'unsure' {
  if (result.items.length !== 1 || result.doubts.length > 0) return 'unsure';
  const it = result.items[0];
  if (!it || (it.kind !== 'event' && it.kind !== 'todo')) return 'unsure';
  const day = it.kind === 'event' ? it.date : it.due;
  return day !== null && it.confirm === null ? 'sure' : 'unsure';
}
