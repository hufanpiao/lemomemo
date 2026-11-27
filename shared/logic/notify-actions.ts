// 通知上的按钮（R-294、R-307、R-308）：从 notify-text.ts 拆出来，给 SW（src/sw/push-actions.ts）和后端 push-dispatch 共用同一份。
// **这个文件不 import 任何东西**：SW 包只准引白名单里的模块（tests/build/sw-no-user-data.test.ts），
// 引 notify-text.ts 会把时区、日期代码一起带进 SW 包（代码审查 N3 / FA2-4）。notify-text.ts 原样转出这里的全部导出。

export type NotifyKind = 'event' | 'todo' | 'anniv';

/** 通知按钮“推迟”推迟多少分钟（R-307：一律 10 分钟） */
export const SNOOZE_MIN = 10;

/** 通知上的按钮：action 名（SW 的 notification action，也是负载 v1 里的字段名）和文字的词典键（R-294、R-307、R-308） */
export const NOTIFY_ACTIONS = {
  /** 推迟 SNOOZE_MIN 分钟（三种条目都有） */
  snooze: { action: 'snooze', key: 'remind.push.action.snooze', minutes: SNOOZE_MIN },
  /** 完成（只给待办；和推迟走同一条 pending 路径、完成后能撤销） */
  done: { action: 'done', key: 'remind.push.action.done' },
  /** 知道了（只给日程、纪念日；只关通知、不改数据） */
  ack: { action: 'ack', key: 'remind.push.action.ack' },
} as const;

export type NotifyAction = keyof typeof NOTIFY_ACTIONS;

/** 这种条目的通知上放哪两个按钮（顺序就是显示顺序）：待办“推迟 + 完成”，日程、纪念日“推迟 + 知道了”（R-308） */
export function actionsFor(kind: NotifyKind): readonly [NotifyAction, NotifyAction] {
  return kind === 'todo' ? ['snooze', 'done'] : ['snooze', 'ack'];
}
