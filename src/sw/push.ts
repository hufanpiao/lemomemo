// SW 的推送和通知（架构 5.3；B2 任务单 FA-1，第一天派工表第 9 行）
// • push：解开推送负载，先核对账号（B2 安全审查 FE-1）：只读打开本机库读 owner，负载的 user_id 和 owner 一致才显示负载里的字；
//   没有库、没有 owner、不一致、读库出错一律只显示 App 名（不带正文、按键、data），tag 照旧（同一条的 resolve 还能替换它）
// • 显示系统通知（tag = "<kind>:<id>:<due_at>"，5.3 第 4 步）；resolve 类型先关掉同 tag 的旧通知，
//   再静默显示一条同 tag 的“已在另一台设备上处理”（浏览器要求每条推送都显示通知，只能替换、不能直接删）
// • notificationclick：点通知本身 → 打开（或聚焦已开的窗口并跳到）这一条的整页提醒；
//   点“推迟”“完成”按键 → 按 K-sw-seal 写 pending_actions（./pending.ts），再打开整页提醒，由页面转成 outbox（0.29 续第 102 条③）；
//   推迟、完成走同一条 pending 路径，完成在整页提醒里能撤销（R-294 安全审查条件）。点“知道了”只关通知：不写库、不开窗口（R-308）。
//   按钮怎么排、哪种条目有哪个见 ./push-actions.ts
//   通知上的 data 读回来时和负载用同一套校验（FE-3），不合格就只打开 /app/；打开的地址只有 reminderUrl(...) 和 '/app/' 两种
// • notificationclose：用户划掉通知不算“知道了”，不写任何东西（到点没处理的照样进“错过的提醒”，按 notified_for 判断，5.9）
// SW 不拿令牌调接口、不自己发请求；负载里只用到下面这些字段，别的忽略（负载里永远没有地址、图片字段）
//
// 负载 v1（B2 任务单“接口先定”第 2 条；代码审查 M1 定稿，后端 BE-1 按这个发）：
//   remind  { v: 1, type: 'remind', user_id, kind: 'event' | 'todo' | 'anniv', id, due_at, title?, body?, snooze?, done?, ack? }
//           done = { label }（只待办）、ack = { label }（只日程、纪念日），R-307、R-308
//           title 只在用户开着“通知显示标题”（push_show_title）时带（架构 0.53）；没带就用 App 名当标题，body 照用（代码审查 M3）
//   resolve { v: 1, type: 'resolve', user_id, kind, id, due_at }            —— 不带标题、正文；SW 用公共词典 push.resolved
//   test    { v: 1, type: 'test', user_id }                                  —— push-test 发；SW 用公共词典 push.test，点开只进 /app/
//   user_id、id 是 UUID；due_at 是正的安全整数（epoch ms）；snooze = { label: '10 分钟后', minutes: 10 }（文案由服务器按 ui_locale 生成）
//   title、body、按键文字里的控制字符（C0、DEL、C1、双向控制符和方向标记、行段分隔符、U+FEFF）换成空格（BE-2 安全审查，见 CONTROL_CHARS）；
//   title、body 超过 TEXT_MAX（300）字时截断（末尾补 …），不整条拒收（代码审查 S1）；服务器 notify-text 截到各 ≤ 300 字、整份 JSON ≤ 3071 字节（架构 5.3，0.53）
// 整页提醒的地址（reminderUrl）、tag 只写在 shared/logic/remind-route.ts（架构 0.53），和 platform 的 openReminder 是同一份
import { t } from '../../shared/i18n/i18n.ts';
import { pickLocale } from '../../shared/i18n/pick-locale.ts';
import { reminderTag, reminderUrl, type ReminderKind } from '../../shared/logic/remind-route.ts';
import { actionsOf, buttonsOf, isSnoozeMin, type RemindButtons } from './push-actions.ts';
import { readSwOwner, writePendingAction, type PendingWriteResult, type SwPendingAction } from './pending.ts';

// 地址、tag 的拼法只留一份（shared/logic/remind-route.ts，架构 0.53）；这里原样转出，SW 一侧仍叫 reminderUrl、notificationTag
export { reminderUrl, type ReminderKind };

interface ItemRef {
  readonly user_id: string;
  readonly kind: ReminderKind;
  readonly id: string;
  /** 这一次到点的时刻（epoch ms），也是 tag 的一部分 */
  readonly due_at: number;
}

export type PushPayload =
  | (ItemRef & {
      readonly v: 1;
      readonly type: 'remind';
      /** 没带（push_show_title 关着）为 null：显示时用 App 名 */
      readonly title: string | null;
      readonly body: string;
    } & RemindButtons)
  | (ItemRef & { readonly v: 1; readonly type: 'resolve' })
  | { readonly v: 1; readonly type: 'test'; readonly user_id: string };

/** 通知上带的数据（notificationclick 里读回来，dataOf 再校验一遍） */
export interface NotificationData extends ItemRef {
  readonly snooze_minutes: number | null;
  /** 通知上有“完成”（只待办） */
  readonly done_ok: boolean;
}

const KINDS: ReadonlySet<string> = new Set(['event', 'todo', 'anniv']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** 通知标题、正文的上限（字数，按 Unicode 字符计）；超了截断 */
export const TEXT_MAX = 300;
/** 负载解不开时那条通知的 tag */
export const FALLBACK_TAG = 'lemo-fallback';
/** 测试推送的 tag（同一时间只留一条） */
export const TEST_TAG = 'lemo-test';
const ICON = '/app/icons/icon-192.png';

/** 按 kind 找表名（pending_actions 的 row_table） */
const TABLE_OF: Record<ReminderKind, SwPendingAction['row_table']> = {
  event: 'events',
  todo: 'todos',
  anniv: 'anniversaries',
};

const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);
const isDueAt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isKind = (v: unknown): v is ReminderKind => typeof v === 'string' && KINDS.has(v);

/**
 * 通知里不能出现的控制字符（BE-2 安全审查，和后端 _shared/push/payload.ts 同一套）：C0（U+0000～U+001F）、DEL（U+007F）、
 * C1（U+0080～U+009F）、双向控制符（U+202A～U+202E、U+2066～U+2069）、方向标记（U+200E、U+200F、U+061C）、
 * 行、段分隔符（U+2028、U+2029）、BOM / 零宽不换行空格（U+FEFF）。一律换成空格，不整条拒收
 */
// eslint-disable-next-line no-control-regex -- 就是要匹配这些控制字符
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** 先把控制字符换成空格，再超长截断（按字符，不切开 emoji 这类代理对），末尾补 … */
export function clipText(raw: string, max: number = TEXT_MAX): string {
  const s = raw.replace(CONTROL_CHARS, ' ');
  if (s.length <= max) return s;
  const cs = Array.from(s);
  return cs.length <= max ? s : `${cs.slice(0, max - 1).join('')}…`;
}

/** 负载和通知 data 共用的校验（FE-3）：user_id、id 是 UUID，kind 认识，due_at 是正的安全整数 */
function itemRefOf(o: Record<string, unknown>): ItemRef | null {
  const { user_id: uid, kind, id, due_at: dueAt } = o;
  return isUuid(uid) && isKind(kind) && isUuid(id) && isDueAt(dueAt) ? { user_id: uid, kind, id, due_at: dueAt } : null;
}

/** 解开推送负载；格式不对返回 null（调用方照样要显示一条通知，见 handlePush） */
export function parsePushPayload(raw: unknown): PushPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['v'] !== 1 || !isUuid(o['user_id'])) return null;
  const type = o['type'];
  if (type === 'test') return { v: 1, type: 'test', user_id: o['user_id'] };
  if (type !== 'remind' && type !== 'resolve') return null;
  const ref = itemRefOf(o);
  if (!ref) return null;
  // resolve 不带标题、正文（接口先定第 2 条）：带了也不用
  if (type === 'resolve') return { v: 1, type: 'resolve', ...ref };
  // title、body 可省（null 也当没带）；带了就必须是字符串
  const title = o['title'] ?? null;
  const body = o['body'] ?? '';
  if ((title !== null && typeof title !== 'string') || typeof body !== 'string') return null;
  const shown = title === null || title === '' ? null : clipText(title);
  return { v: 1, type: 'remind', ...ref, title: shown, body: clipText(body), ...buttonsOf(o, ref.kind, clipText) };
}

/** Web Push 的 tag（5.3 第 4 步）："<kind>:<id>:<due_at>"（= shared 的 reminderTag） */
export const notificationTag = reminderTag;

/** 本机的界面语言（SW 读不到 localStorage 里选过的语言：按浏览器语言走 pickLocale，和首页没选过语言时同一条规则） */
function localeOf(languages: readonly string[]): 'zh-CN' | 'ko-KR' {
  return pickLocale(null, languages) === 'ko' ? 'ko-KR' : 'zh-CN';
}

/** 兜底标题：只写 App 名（公共词典 app.name，A20 不准写死中文） */
export function fallbackTitle(languages: readonly string[]): string {
  return t('app.name', {}, localeOf(languages));
}

type ShownOptions = NotificationOptions & { actions?: { action: string; title: string }[] };

/** 通知要显示的东西（showNotification 的两个参数）。resolve、test 的字一律取本地词典（FE-S1），不用负载里的 */
export function notificationOf(p: PushPayload, languages: readonly string[]): { title: string; options: ShownOptions } {
  const loc = localeOf(languages);
  const appName = t('app.name', {}, loc);
  if (p.type === 'test') return { title: appName, options: { body: t('push.test', {}, loc), tag: TEST_TAG, icon: ICON, badge: ICON } };
  const data: NotificationData = {
    user_id: p.user_id,
    kind: p.kind,
    id: p.id,
    due_at: p.due_at,
    snooze_minutes: p.type === 'remind' ? (p.snooze?.minutes ?? null) : null,
    done_ok: p.type === 'remind' && p.done !== null,
  };
  const base = { tag: notificationTag(p.kind, p.id, p.due_at), data, icon: ICON, badge: ICON };
  if (p.type === 'resolve') return { title: appName, options: { ...base, body: t('push.resolved', {}, loc), silent: true } };
  const options: ShownOptions = { ...base, body: p.body };
  const actions = actionsOf(p.kind, p);
  if (actions.length) options.actions = actions;
  return { title: p.title ?? appName, options };
}

/** 用到的 WindowClient 部分（只写最小接口：tests/build 用 node 的 tsconfig 编译，没有 webworker 的类型） */
export interface WindowLike {
  readonly url: string;
  focus(): Promise<WindowLike>;
  navigate(url: string): Promise<WindowLike | null>;
}

/** 用到的 self.clients 部分 */
export interface ClientsLike {
  matchAll(opts: { type: 'window'; includeUncontrolled: boolean }): Promise<readonly WindowLike[]>;
  openWindow(url: string): Promise<unknown>;
}

/** SW 全局里用到的部分（测试时传假的） */
export interface SwLike {
  readonly registration: Pick<ServiceWorkerRegistration, 'showNotification' | 'getNotifications'>;
  readonly clients: ClientsLike;
  readonly location: { readonly origin: string };
  readonly indexedDB: IDBFactory;
  readonly now: () => number;
  readonly uuid: () => string;
  /** navigator.languages（只用来挑固定文案的语言） */
  readonly languages: readonly string[];
}

/** 本机库的 owner（FE-1；读不出一律 null） */
async function ownerOf(sw: SwLike): Promise<string | null> {
  try {
    return await readSwOwner(sw.indexedDB);
  } catch {
    return null;
  }
}

/** push 事件：核对账号后显示通知；resolve 先关掉同 tag 的旧通知再替换（5.3“Edge 安装版”） */
export async function handlePush(sw: SwLike, raw: unknown): Promise<void> {
  const p = parsePushPayload(raw);
  if (!p) {
    await sw.registration.showNotification(fallbackTitle(sw.languages), { tag: FALLBACK_TAG });
    return;
  }
  const { title, options } = notificationOf(p, sw.languages);
  const tag = options.tag ?? FALLBACK_TAG;
  if (p.type === 'resolve') {
    try {
      for (const n of await sw.registration.getNotifications({ tag })) n.close();
    } catch {
      // getNotifications 不支持（iOS 未核实，5.3）：只靠下面同 tag 的替换
    }
  }
  // FE-1：不是本机库的账号（或没有库、没有 owner、读不出）就只写 App 名，不带正文、按键和 data，tag 照旧
  if ((await ownerOf(sw)) !== p.user_id) {
    await sw.registration.showNotification(fallbackTitle(sw.languages), p.type === 'resolve' ? { tag, silent: true } : { tag });
    return;
  }
  await sw.registration.showNotification(title, options);
}

/** 读回通知上的数据，和负载同一套校验（FE-3）；不是我们发的、或有一项不合格返回 null */
export function dataOf(n: { data?: unknown }): NotificationData | null {
  const d = n.data;
  if (typeof d !== 'object' || d === null) return null;
  const o = d as Record<string, unknown>;
  const ref = itemRefOf(o);
  if (!ref) return null;
  const sm = o['snooze_minutes'];
  return { ...ref, snooze_minutes: isSnoozeMin(sm) ? sm : null, done_ok: o['done_ok'] === true && ref.kind === 'todo' };
}

/** 只会打开这两种地址：reminderUrl(...) 或 APP_HOME */
const APP_HOME = '/app/';

/**
 * 打开整页提醒：已经开着 /app/ 的窗口就聚焦它并跳过去（只改 hash，不重新载入），没有就新开一个。
 * WindowClient.navigate 只能用在本 SW 控制的窗口上，不行就退回新开
 */
export async function openReminderWindow(sw: SwLike, url: string): Promise<void> {
  const full = new URL(url, sw.location.origin).href;
  const wins = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const app = wins.find((w) => new URL(w.url).pathname.startsWith(APP_HOME));
  if (app) {
    try {
      const focused = await app.focus();
      await focused.navigate(full);
      return;
    } catch {
      // 聚焦或跳转被拒（不是本 SW 控制的窗口等）：退回新开
    }
  }
  await sw.clients.openWindow(full);
}

/** notificationclick 的结果（测试和日志用）：snooze、done 时带写库结果（另一个为 null） */
export type ClickResult =
  | { opened: string; snooze: PendingWriteResult | null; done: PendingWriteResult | null }
  | { opened: null; snooze: null; done: null };

/**
 * notificationclick：先关通知；点“推迟”先写 pending_actions（失败也照样打开整页提醒，用户在页内再按一次）；
 * 再打开这一条的整页提醒。不是我们的通知（没有 data 或校验不过）就只打开 /app/
 */
export async function handleNotificationClick(
  sw: SwLike,
  n: { data?: unknown; close(): void },
  action: string,
): Promise<ClickResult> {
  n.close();
  const d = dataOf(n);
  if (!d) {
    await openReminderWindow(sw, APP_HOME);
    return { opened: null, snooze: null, done: null };
  }
  // 知道了（日程、纪念日）：只关通知，不改数据、不开窗口（R-308）
  if (action === 'ack' && d.kind !== 'todo') return { opened: null, snooze: null, done: null };
  // 多行写法别改成一行：tests/build/sw-no-user-data.test.ts 按这个写法核对“正好一处调用、顶层正好 6 个字段”（FE-4 ②）
  const write = (act: SwPendingAction['action']): Promise<PendingWriteResult> => {
    return writePendingAction(sw.indexedDB, {
      id: sw.uuid(),
      user_id: d.user_id,
      row_table: TABLE_OF[d.kind],
      row_id: d.id,
      action: act,
      created_at: sw.now(),
    });
  };
  let snooze: PendingWriteResult | null = null;
  let done: PendingWriteResult | null = null;
  if (action === 'snooze' && d.snooze_minutes !== null) snooze = await write({ type: 'snooze', minutes: d.snooze_minutes, due_at: d.due_at });
  // 完成（只待办）：和推迟同一条 pending 路径，页面转成 outbox，整页提醒里能撤销（R-294）
  if (action === 'done' && d.done_ok) done = await write({ type: 'done', due_at: d.due_at });
  const url = reminderUrl(d.kind, d.id, d.due_at);
  await openReminderWindow(sw, url);
  return { opened: url, snooze, done };
}
