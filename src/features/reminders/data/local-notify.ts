// 本机通知（B2 任务单 FA-4 exe 约定；架构 5.3“exe”、0.49 第 8 条、0.53“platform 的四个函数”；TC-B6X-11、TC-B2-78）：纯 TS
// • exe 收不到 Web Push：App 内每分钟检查一次，到点的交 platform 的 showLocalReminder 弹（网页版是空操作）；
//   按 notified_for 判断要不要弹（handled），不写 pushed_for（服务器照常给手机推，两边都响，R-52 已接受）
// • 窗口：到点后 60 分钟内（和 push-dispatch 第 1 步同一个窗口，R-335：超过 60 分钟就不响）；同一次提醒只弹一次（shown 记着）
// • “同一次提醒”（shownKey）：一般按 tag（kind:id:到点时刻）；全天日程（没按稍后）按“这一条、这一天、当天 / 前一天”记，不看时刻——
//   当天已经弹过，再改 remind.default_time 不再弹第二次，新时刻只对还没响的和以后的日子生效（R-336）；按了“稍后”的照样按 tag，到点照响
// • 别处处理了（知道了、稍后、完成、删除，R-317）：closeLocalReminder 按 tag 撤回
// • 文案和服务器同一规则（5.3 第 4 步，0.53）：notify-text 生成键，按界面语言翻；条目 push_show_title ?? 设置 remind.show_title ?? true 为假时
//   只写“15:00 有 1 项日程”这类说法、不带截止时刻（TC-B2-78）；source = chat 加“来自 Claude ·”
// • 打开 App 时关掉已处理的系统通知（iPhone 不发 resolve，5.3）：shouldCloseShown 判断某个 tag 是不是已处理
import type { Tz } from '../../../../shared/core/tz.ts';
import { t as sharedT, type Locale } from '../../../../shared/i18n/i18n.ts';
import { notifyText, type NotifyMsg } from '../../../../shared/logic/notify-text.ts';
import { startAtOf } from '../../../../shared/logic/remind-actions.ts';
import { todayOf } from '../../../../shared/core/date.ts';
import { allDayRemindDay, occurrenceKey, type Reminder } from './reminder-model.ts';

export const LOCAL_WINDOW_MS = 60 * 60_000;

/** “同一次提醒”的标识（R-336）：和横幅、错过的提醒同一套（reminder-model 的 occurrenceKey） */
export const shownKey = occurrenceKey;

/** 弹过的：Set 里放 shownKey（旧写法放 tag，非全天两者一样），或者 Map<shownKey, 弹出时的 tag> */
export type Shown = ReadonlySet<string> | ReadonlyMap<string, string>;

/**
 * 现在该弹的：到点（dueAt ≤ now）、60 分钟内、没处理、这一次提醒还没弹过；
 * rang（REMIND-shown-persist）：这一次响过、当时的 tag 和现在不同的（服务器推过、后来改了默认时刻）也不弹；tag 相同的照旧弹（R-52）；
 * 本机弹过的（local）不再弹（代码审查一 L12：staleShown 撤回后 shown 里删了 key，同一次又回到“该响”——撤销“知道了”、撤销删除——
 * 60 分钟内不再弹第二次；稍后、改时间会换 key，不受影响）
 */
export function localDue(list: readonly Reminder[], now: number, shown: Shown, rang?: ReadonlyMap<string, { readonly tag: string; readonly local?: boolean } | string>): Reminder[] {
  return list.filter((r) => {
    if (r.handled || r.dueAt > now || r.dueAt <= now - LOCAL_WINDOW_MS || shown.has(shownKey(r))) return false;
    const before = rang?.get(shownKey(r));
    if (before === undefined) return true;
    if (typeof before === 'string') return before === r.tag;
    return before.local !== true && before.tag === r.tag;
  });
}

/** 弹过的里面，现在已经不在“该响”名单里的（处理了、改了时间、删了）：[shownKey, 要撤回的 tag] */
export function staleShown(shown: Shown, list: readonly Reminder[]): [string, string][] {
  const live = new Set(list.filter((r) => !r.handled).map(shownKey));
  const pairs: [string, string][] = shown instanceof Map ? [...shown.entries()] : [...(shown as ReadonlySet<string>)].map((k) => [k, k]);
  return pairs.filter(([k]) => !live.has(k));
}

/** 只要 tag 的旧写法（shown 里放的是 tag） */
export function staleTags(shown: ReadonlySet<string>, list: readonly Reminder[]): string[] {
  return staleShown(shown, list).map(([, tag]) => tag);
}

/** 写不写标题：条目 push_show_title ?? 设置 remind.show_title ?? true */
export function showTitleFor(r: Reminder, settingShowTitle: boolean): boolean {
  const v = r.row['push_show_title'];
  return typeof v === 'boolean' ? v : settingShowTitle;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** 通知上显示的时刻：日程是开始时刻，待办是这一次提醒的时刻（notify-text 的 timeMs） */
export function timeMsOf(r: Reminder, tz: Tz, defaultTime?: string): number {
  if (r.kind === 'event') {
    const date = str(r.row['date']);
    if (date !== null) return startAtOf({ date, time: str(r.row['time']), tz: str(r.row['tz']) }, tz, defaultTime);
  }
  return r.dueAt;
}

/** 全天日程（time 为空）传给 notify-text 的 {date, at}；有时刻的日程、待办为 null */
function allDayOf(r: Reminder): { date: string; at: number } | null {
  if (r.kind !== 'event' || str(r.row['time']) !== null) return null;
  const date = str(r.row['date']);
  return date === null ? null : { date, at: r.dueAt };
}

/** 本机通知的标题、正文（界面语言） */
export function localText(r: Reminder, opts: { showTitle: boolean; tz: Tz; locale: Locale; defaultTime?: string }): { title: string; body: string } {
  const n = notifyText({
    kind: r.kind,
    title: r.title,
    source: r.source,
    showTitle: showTitleFor(r, opts.showTitle),
    timeMs: timeMsOf(r, opts.tz, opts.defaultTime),
    dueTime: r.kind === 'todo' ? str(r.row['due_time']) : null,
    tz: opts.tz,
    // 全天日程不写时刻（R-333）：按这一次到点的时刻（已按免打扰推迟）比日程日期，写“今天 / 明天 · 名称”
    allDay: allDayOf(r),
  });
  const one = (m: NotifyMsg): string => (m.key === null ? m.params.text : sharedT(m.key, m.params as never, opts.locale));
  const title = one(n.title);
  return {
    title: n.fromClaude ? sharedT('remind.push.fromClaude', { text: title }, opts.locale) : title,
    body: n.body ? one(n.body) : '',
  };
}

/**
 * 系统里还挂着的某条通知（kind、id、那一次的 dueAt）是不是已经处理了：
 * 删了、撤销、待办完成、关了提醒、按了知道了，或者这一条现在的到点时刻已经不是那一次（改了时间、按了稍后）。
 * 纪念日和日程、待办同一套（审查第 8 条）：list、rowKnown 只在纪念日推算加载好以后才带纪念日行（remind-list.ts），没加载好时 rowKnown 为 false、不动它。
 * rowKnown：本机集合里有没有这一行（含已删的）。本机没有这一行时不动它——可能是还没拉下来，不能当成已删（永久删除的靠墓碑删本机行后，
 * 下次打开也就留着那条通知；接受，点开整页提醒会写“找不到了”）
 */
const num0 = (v: unknown): boolean => v === 0;

export function shouldCloseShown(t: { kind: string; id: string; dueAt: number; occurrenceKey?: string | null }, list: readonly Reminder[], rowKnown: boolean, tz?: Tz): boolean {
  const r = list.find((x) => x.kind === t.kind && x.id === t.id);
  if (!r) return rowKnown;
  if (r.handled) return true;
  // 通知 data 里带了 occurrenceKey（REMIND-close-occkey，方案第 6 节 L1）：先按 key 判，等于这一次的就留着（R-336 ①），不等就关，不看 tag——
  // 默认时刻设成 20:00 时，“D 当天 20:00”和“D+1 前一天 20:00”是同一个时刻，tag 相同、key 不同，先比 tag 会把旧通知留下
  if (typeof t.occurrenceKey === 'string') return t.occurrenceKey !== occurrenceKey(r);
  // 没带 key（旧通知、iPhone 拿不到 data）：tag 相同留着，不同就按下面的推断
  if (r.tag === `${t.kind}:${t.id}:${t.dueAt}`) return false;
  // 全天日程（没按稍后）改了 remind.default_time：已经弹出的那条是同一次、还没处理，不撤回（R-336 ①，和 exe 本机通知一致，服务器也不发 resolve）。
  // “同一次”按 occurrenceKey（日期 + 当天 / 前一天）认（审查 L7）：系统通知只带 tag（kind:id:dueAt），拿不到弹出时的日期和 remind_days，
  // 所以只有“改默认时刻”这一种会让同一次的 tag 变——现在是当天提醒、弹出的那条落在这个日期当天，才算同一次；
  // 前一天提醒固定 20:00，同一次的 tag 不会变，对不上就是另一次（例：挪到 11-06 改成前一天提醒，旧的“今天 · X”要撤）
  const day = tz !== undefined && occurrenceKey(r) !== r.tag && num0(r.row['remind_days']) ? allDayRemindDay(r.row) : null;
  return !(day !== null && todayOf(t.dueAt, tz as Tz) === day);
}
