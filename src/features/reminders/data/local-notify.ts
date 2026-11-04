// 本机通知（B2 任务单 FA-4 exe 约定；架构 5.3“exe”、0.49 第 8 条、0.53“platform 的四个函数”；TC-B6X-11、TC-B2-78）：纯 TS
// • exe 收不到 Web Push：App 内每分钟检查一次，到点的交 platform 的 showLocalReminder 弹（网页版是空操作）；
//   按 notified_for 判断要不要弹（handled），不写 pushed_for（服务器照常给手机推，两边都响，R-52 已接受）
// • 窗口：到点后 60 分钟内（和 push-dispatch 第 1 步同一个窗口）；同一个 tag 只弹一次（shown 记着）
// • 别处处理了（知道了、稍后、完成、删除，R-317）：closeLocalReminder 按 tag 撤回
// • 文案和服务器同一规则（5.3 第 4 步，0.53）：notify-text 生成键，按界面语言翻；条目 push_show_title ?? 设置 remind.show_title ?? true 为假时
//   只写“15:00 有 1 项日程”这类说法、不带截止时刻（TC-B2-78）；source = chat 加“来自 Claude ·”
// • 打开 App 时关掉已处理的系统通知（iPhone 不发 resolve，5.3）：shouldCloseShown 判断某个 tag 是不是已处理
import type { Tz } from '../../../../shared/core/tz.ts';
import { t as sharedT, type Locale } from '../../../../shared/i18n/i18n.ts';
import { notifyText, type NotifyMsg } from '../../../../shared/logic/notify-text.ts';
import { startAtOf } from '../../../../shared/logic/remind-actions.ts';
import type { Reminder } from './reminder-model.ts';

export const LOCAL_WINDOW_MS = 60 * 60_000;

/** 现在该弹的：到点（dueAt ≤ now）、60 分钟内、没处理、还没弹过 */
export function localDue(list: readonly Reminder[], now: number, shown: ReadonlySet<string>): Reminder[] {
  return list.filter((r) => !r.handled && r.dueAt <= now && r.dueAt > now - LOCAL_WINDOW_MS && !shown.has(r.tag));
}

/** 弹过的 tag 里，现在已经不在“该响”名单里的（处理了、改了时间、删了）：要撤回 */
export function staleTags(shown: ReadonlySet<string>, list: readonly Reminder[]): string[] {
  const live = new Set(list.filter((r) => !r.handled).map((r) => r.tag));
  return [...shown].filter((tag) => !live.has(tag));
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
 * rowKnown：本机集合里有没有这一行（含已删的）。本机没有这一行时不动它——可能是还没拉下来，不能当成已删（永久删除的靠墓碑删本机行后，
 * 下次打开也就留着那条通知；接受，点开整页提醒会写“找不到了”）
 */
export function shouldCloseShown(t: { kind: string; id: string; dueAt: number }, list: readonly Reminder[], rowKnown: boolean): boolean {
  if (t.kind === 'anniv') return false;   // 纪念日本批不在列表里，不动它
  const r = list.find((x) => x.kind === t.kind && x.id === t.id);
  if (!r) return rowKnown;
  return r.handled || r.tag !== `${t.kind}:${t.id}:${t.dueAt}`;
}
