// 通知上的按钮（R-294、R-307、R-308；src/sw/push.ts 用）：待办“推迟 + 完成”，日程、纪念日“推迟 + 知道了”。
// 顺序、action 名取 shared/logic/notify-actions.ts 的 actionsFor（和后端同一份；那个文件不 import 任何东西，不把日期代码带进 SW 包）；文字用负载里服务器按 ui_locale 生成的 label。
// 负载里有哪个就显示哪个，没有的不显示；按类型再守一次：不是待办的不认 done，待办不认 ack（后端 payload.ts 同样丢掉）。
// • snooze：{ label, minutes }，minutes 是 1～1440 的整数才认（后端一律发 SNOOZE_MIN = 10）
// • done、ack：{ label }
import { actionsFor, type NotifyAction } from '../../shared/logic/notify-actions.ts';
import type { ReminderKind } from '../../shared/logic/remind-route.ts';

/** 按键文字的上限（码点；和后端 payload.ts 的 LABEL_MAX 一致） */
export const LABEL_MAX = 40;
/** 推迟分钟数的范围（1 分钟～1 天） */
export const SNOOZE_MAX_MIN = 24 * 60;

export const isSnoozeMin = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= SNOOZE_MAX_MIN;

export interface RemindButtons {
  readonly snooze: { readonly label: string; readonly minutes: number } | null;
  /** 只有待办 */
  readonly done: { readonly label: string } | null;
  /** 只有日程、纪念日 */
  readonly ack: { readonly label: string } | null;
}

type Clip = (s: string, max: number) => string;

function labelOf(v: unknown, clip: Clip): string | null {
  if (typeof v !== 'object' || v === null) return null;
  const label = (v as Record<string, unknown>)['label'];
  return typeof label === 'string' && label !== '' ? clip(label, LABEL_MAX) : null;
}

/** 从负载里取三个按钮（格式不对的当没有，整条照收） */
export function buttonsOf(o: Record<string, unknown>, kind: ReminderKind, clip: Clip): RemindButtons {
  const s = o['snooze'];
  const sl = labelOf(s, clip);
  const minutes = typeof s === 'object' && s !== null ? (s as Record<string, unknown>)['minutes'] : undefined;
  const dl = kind === 'todo' ? labelOf(o['done'], clip) : null;
  const al = kind !== 'todo' ? labelOf(o['ack'], clip) : null;
  return {
    snooze: sl !== null && isSnoozeMin(minutes) ? { label: sl, minutes } : null,
    done: dl !== null ? { label: dl } : null,
    ack: al !== null ? { label: al } : null,
  };
}

/** showNotification 的 actions：按 actionsFor(kind) 的顺序，只放负载里有的 */
export function actionsOf(kind: ReminderKind, b: RemindButtons): { action: NotifyAction; title: string }[] {
  const out: { action: NotifyAction; title: string }[] = [];
  for (const a of actionsFor(kind)) {
    const btn = b[a];
    if (btn) out.push({ action: a, title: btn.label });
  }
  return out;
}
