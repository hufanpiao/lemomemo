// 推送文案（架构 5.3 第 4 步、2.4 第 3 点“logic 只返回键”；B2 任务单 BE-2；R-46、R-188 保留项、0.29 续第 138 条）。
// 只返回词典键和参数（{key, params}），由 push-dispatch 按用户的 ui_locale 调 t() 生成文字；本机通知（前端 A）可以用同一份。
//   • 默认直接写标题（R-46）：
//       日程 → 标题“{time} {title}”（remind.push.event，time 是日程开始时刻、按用户当前时区显示），不带正文；
//       待办 → 标题是待办标题；有截止时刻的正文“{time} 截止”（remind.push.todoDue），没有的不带正文；
//       纪念日 → 标题是名字（“明天是妈妈生日（60 岁）”这类写法归 B5 的 logic/anniv，这里先只写名字），不带正文；
//   • 不写标题（条目 push_show_title 为 false，或它为空且设置 remind.show_title 为 false）：按类型分开说（R-294、R-308，负责人 11-03）——
//     日程“{time} 有 1 项日程”（remind.push.hidden）、待办“{time} 有 1 项待办”（remind.push.hiddenTodo）、
//     纪念日“{time} 有 1 项纪念日”（remind.push.hiddenAnniv）；不带正文、不带截止时刻；time 对日程是开始时刻，对待办、纪念日是这一次提醒的时刻；
//   • 通知上的两个按钮（R-294、R-307、R-308）：待办“推迟 + 完成”，日程、纪念日“推迟 + 知道了”，见 NOTIFY_ACTIONS、actionsFor（定义在 notify-actions.ts，这里转出）；
//     推迟一律 SNOOZE_MIN = 10 分钟；“知道了”只关通知、不改数据；SW 怎么处理归前端 A（推迟和完成走同一条 pending 路径、完成后能撤销）；
//   • source = chat（经 Claude 记下的）：标题前加“来自 Claude · ”（remind.push.fromClaude 包一层），写不写标题都加。
// 截断（各 ≤ 300 码点、整份 ≤ 3071 字节）在 _shared/push/payload.ts 的 buildPayload 里做，这里不截。
// 纯函数：不读设置、不碰 DOM、不看进程时区；时区由调用方传（A15）。
import { wallTime, type Tz } from '../core/tz.ts';
import type { NotifyKind } from './notify-actions.ts';

// 按钮常量拆到不 import 任何东西的 notify-actions.ts（SW 也引它）；这里原样转出，后端的引用不用改
export { actionsFor, NOTIFY_ACTIONS, SNOOZE_MIN, type NotifyAction, type NotifyKind } from './notify-actions.ts';

/** 词典键和参数；键都在 shared/i18n/zh.ts、ko.ts 的 remind.push.* 里 */
export type NotifyMsg =
  | { key: 'remind.push.event'; params: { time: string; title: string } }
  | { key: 'remind.push.todoDue'; params: { time: string } }
  | { key: 'remind.push.hidden'; params: { time: string } }
  | { key: 'remind.push.hiddenTodo'; params: { time: string } }
  | { key: 'remind.push.hiddenAnniv'; params: { time: string } }
  | { key: 'remind.push.fromClaude'; params: { text: string } }
  /** 原样的一段文字（条目标题、纪念日名字），不查词典 */
  | { key: null; params: { text: string } };

export interface NotifyInput {
  kind: NotifyKind;
  /** 条目标题（纪念日是名字） */
  title: string;
  source: string;
  /** 已按“条目 push_show_title ?? 设置 remind.show_title ?? true”算好 */
  showTitle: boolean;
  /** 要显示的时刻（毫秒）：日程是开始时刻，待办、纪念日是这一次提醒的时刻（due_at） */
  timeMs: number;
  /** 待办的截止时刻（HH:MM，浮动时刻，原样显示）；没有为 null */
  dueTime: string | null;
  /** 用户当前时区（profiles.current_tz） */
  tz: Tz;
}

export interface NotifyText {
  title: NotifyMsg;
  /** title 外面要不要再包一层 remind.push.fromClaude */
  fromClaude: boolean;
  body: NotifyMsg | null;
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n));

/** 时刻 ms 在 tz 的 HH:MM */
export function hhmm(ms: number, tz: Tz): string {
  const w = wallTime(ms, tz);
  return `${pad2(w.hh)}:${pad2(w.mm)}`;
}

export function notifyText(i: NotifyInput): NotifyText {
  const time = hhmm(i.timeMs, i.tz);
  const fromClaude = i.source === 'chat';
  if (!i.showTitle) {
    const title: NotifyMsg = i.kind === 'todo' ? { key: 'remind.push.hiddenTodo', params: { time } }
      : i.kind === 'anniv' ? { key: 'remind.push.hiddenAnniv', params: { time } } : { key: 'remind.push.hidden', params: { time } };
    return { title, fromClaude, body: null };
  }
  if (i.kind === 'event') return { title: { key: 'remind.push.event', params: { time, title: i.title } }, fromClaude, body: null };
  if (i.kind === 'todo') {
    return {
      title: { key: null, params: { text: i.title } },
      fromClaude,
      body: i.dueTime !== null ? { key: 'remind.push.todoDue', params: { time: i.dueTime } } : null,
    };
  }
  return { title: { key: null, params: { text: i.title } }, fromClaude, body: null };
}
