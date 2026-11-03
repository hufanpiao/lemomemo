// 整页提醒的地址、hash 和通知 tag（架构 5.3“提醒地址只留一份”，0.53）
// 只写在这一份：SW（src/sw/push.ts，A19 只准引 shared）和页面（src/platform/native-bridge.ts）都从这里引。
// 不 import 任何文件（不能把日期代码带进 SW 包；所以不放进 shared/logic/remind.ts）。纯字符串拼法，不碰 DOM（A2）
// 拼出来的地址必须匹配 ^/app/#/remind/(event|todo|anniv)/<uuid>\?due=[1-9][0-9]*$（B2 安全审查 FE-3，tests/build/native-bridge-url.test.ts）：
// 调用方传进来的 id 要已经校验过是 UUID、dueAt 是正的安全整数（SW 的 dataOf、页面的整页提醒路由各自校验）

/** 哪一类提醒（和推送负载的 kind 同一组值） */
export type ReminderKind = 'event' | 'todo' | 'anniv';

/** 整页提醒在 /app/ 里的 hash（不带 /app/）："#/remind/<kind>/<id>?due=<dueAt>" */
export function reminderHash(kind: ReminderKind, id: string, dueAt: number): string {
  return `#/remind/${kind}/${id}?due=${dueAt}`;
}

/** 整页提醒的完整路径："/app/#/remind/<kind>/<id>?due=<dueAt>" */
export function reminderUrl(kind: ReminderKind, id: string, dueAt: number): string {
  return `/app/${reminderHash(kind, id, dueAt)}`;
}

/** 通知的 tag（Web Push 和 exe 本机通知同一规则，5.3 第 4 步）："<kind>:<id>:<dueAt>" */
export function reminderTag(kind: ReminderKind, id: string, dueAt: number): string {
  return `${kind}:${id}:${dueAt}`;
}
