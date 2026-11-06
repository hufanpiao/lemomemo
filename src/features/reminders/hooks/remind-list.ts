// 提醒列表（从 useReminders 拆出来的轻量部分；今天页首屏的“错过 N 条提醒”一行只用这些，首屏瘦身 H1 第三轮）：
// • useMinuteNow、useRemindPrefs、useReminderList：从本机的 events、todos、settings 现算所有提醒（remindAtOf 和服务器同一份，TC-B2-29）
// • 本次会话只在本机处理过的集合（R4-L1）、本次打开以后响过的（rangSnapshot，R-336）：引擎（useReminders）写，这里和“错过的提醒”读
// • 不带引擎、本机通知、写服务器、弹层这些：那些在 useReminders.ts，首屏用不到
// useReminders.ts 原样转出这里的导出，别处照旧从 useReminders 引
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { currentTz } from '../../../core/current-tz.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { clock } from '../../../platform/clock.ts';
import { allReminders, type Rang, type RangMap, type Reminder, type Row } from '../data/reminder-model.ts';
import { defaultTimeOf, dndOf, KEY_DEFAULT_TIME, KEY_DND, KEY_SHOW_TITLE, settingValue, showTitleOf, type SettingRow } from '../data/remind-settings.ts';

// “错过的提醒”一行要的纯函数和类型（A1：ui 经 hooks 拿 data 的东西）
export { missed, type Reminder } from '../data/reminder-model.ts';

const MIN = 60_000;

/** 每分钟变一次的 now（对齐整分钟，clock.now()）；测试里 spyOn clock.now 就能固定 */
export function useMinuteNow(): number {
  const [now, setNow] = useState(() => clock.now());
  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      const n = clock.now();
      setNow(n);
      t = setTimeout(tick, MIN - (n % MIN) + 50);
    };
    t = setTimeout(tick, MIN - (clock.now() % MIN) + 50);
    // 时钟偏差变了也重算一次（K8-clock）
    const off = clock.subscribe(() => setNow(clock.now()));
    return () => {
      clearTimeout(t);
      off();
    };
  }, []);
  return now;
}

/** 提醒相关的三项设置的类型 */
export type RemindPrefs = ReturnType<typeof useRemindPrefs>;

/** 提醒相关的三项设置（本机 settings 集合） */
export function useRemindPrefs() {
  const rows = useCollection<SettingRow>('settings');
  return useMemo(
    () => ({
      dnd: dndOf(settingValue(rows, KEY_DND)),
      showTitle: showTitleOf(settingValue(rows, KEY_SHOW_TITLE)),
      defaultTime: defaultTimeOf(settingValue(rows, KEY_DEFAULT_TIME)),
    }),
    [rows],
  );
}

// 本次会话只在本机处理过的提醒（R4-L1）：outbox 里还有没上服务器的“换一次提醒”的改动时，“知道了”不写 notified_for，
// 只记 tag 在这里，横幅、错过的提醒、本机通知都当它已处理；引擎卸载（退出登录、换账号）时清空。新的那一次 tag 不同，照常响。
// 外部存储：每次变化整个换一个新的只读 Set（第三轮 L12），useSyncExternalStore 取到的就是 useMemo 的依赖
let sessionAcked: ReadonlySet<string> = new Set();
const sessionAckedSubs = new Set<() => void>();
function subscribeSessionAcked(fn: () => void): () => void {
  sessionAckedSubs.add(fn);
  return () => sessionAckedSubs.delete(fn);
}
const getSessionAcked = (): ReadonlySet<string> => sessionAcked;
function setSessionAcked(next: ReadonlySet<string>): void {
  sessionAcked = next;
  for (const f of [...sessionAckedSubs]) f();
}
export function ackLocally(tag: string): void {
  setSessionAcked(new Set([...sessionAcked, tag]));
}
/** 清空本次会话只在本机处理过的（引擎卸载时；useReminders 另清它的 laterAcks） */
export function clearSessionAcked(): void {
  if (sessionAcked.size > 0) setSessionAcked(new Set());
}
const markSessionAcked = (list: Reminder[], acked: ReadonlySet<string>): Reminder[] =>
  acked.size === 0 ? list : list.map((r) => (acked.has(r.tag) && !r.handled ? { ...r, handled: true } : r));

/** 本机现算的全部提醒（日程、待办） */
export function useReminderList(now: number) {
  const events = useCollection<Row>('events');
  const todos = useCollection<Row>('todos');
  const prefs = useRemindPrefs();
  const tz = currentTz();
  const acked = useSyncExternalStore(subscribeSessionAcked, getSessionAcked, getSessionAcked);
  const list = useMemo(
    () => markSessionAcked(allReminders(events, todos, now, tz, prefs.dnd, prefs.defaultTime), acked),
    [events, todos, now, tz, prefs.dnd, prefs.defaultTime, acked],
  );
  const known = useMemo(() => new Set([...events.map((r) => `event:${r.id}`), ...todos.map((r) => `todo:${r.id}`)]), [events, todos]);
  return { list, tz, prefs, known };
}

// 响过的（R-336；REMIND-shown-persist）：模块私有，只有引擎（useReminders）经 recordRang、loadRang、setPushedRang、clearRang 写（代码复审第三轮 L4）；
// 引擎和“错过的提醒”经 rangSnapshot / useRangView 只读。
// • rangStore：本机记录——引擎挂上时从本机库（meta 的 remind_seen）灌进来的，加上这次打开以后响过的；新记下的同时进 dirty，引擎攒着写回库
// • pushed：服务器 pushed_for 推导出的（引擎在 RemindHost 分包里算好放进来，data/remind-seen.ts 的 rangView）
// • 对外的视图 = pushed 叠上 rangStore（本机记录优先）；每次变化整个换一个新的只读 Map，useSyncExternalStore 取到的就是依赖
export type RangRec = Rang & { readonly local: boolean };
const rangStore = new Map<string, RangRec>();
let pushed: ReadonlyMap<string, RangRec> = new Map();
let dirty = new Map<string, RangRec>();
let view: ReadonlyMap<string, RangRec> = new Map();
const rangSubs = new Set<() => void>();
function republish(): void {
  view = new Map([...pushed, ...rangStore]);
  for (const f of [...rangSubs]) f();
}
/** 引擎用：记一次“响过”（同一个 occurrenceKey 只记第一次；local = 本机弹过系统通知，只会从 false 变 true）。有新的返回 true */
export function recordRang(key: string, rang: Rang, local = false): boolean {
  const old = rangStore.get(key);
  if (old !== undefined && (old.local || !local)) return false;
  const rec: RangRec = old === undefined ? { tag: rang.tag, dueAt: rang.dueAt, local } : { ...old, local: true };
  rangStore.set(key, rec);
  dirty.set(key, rec);
  republish();
  return true;
}
/** 引擎挂上时：从本机库读出来的（更早的那一次，盖过这次打开以后先记下的） */
export function loadRang(items: Readonly<Record<string, RangRec>>): void {
  for (const [k, x] of Object.entries(items)) {
    const now = rangStore.get(k);
    rangStore.set(k, now?.local && !x.local ? { ...x, local: true } : x);
  }
  republish();
}
/** 引擎用：服务器推导出的那一半（整份换掉） */
export function setPushedRang(next: ReadonlyMap<string, RangRec>): void {
  pushed = next;
  republish();
}
/** 引擎用：取走还没写回本机库的 */
export function takeDirtyRang(): Record<string, RangRec> {
  const out = Object.fromEntries(dirty);
  dirty = new Map();
  return out;
}
/** 引擎用：写回本机库失败时放回去，下一次再写（这期间又记下的不盖掉） */
export function putBackDirtyRang(items: Readonly<Record<string, RangRec>>): void {
  for (const [k, x] of Object.entries(items)) if (!dirty.has(k)) dirty.set(k, x);
}
/** 引擎卸载（退出登录、换账号）时清空（没写回的也丢掉：换了账号不能写进别人的库） */
export function clearRang(): void {
  rangStore.clear();
  pushed = new Map();
  dirty = new Map();
  republish();
}
/** 响过的 occurrenceKey → 当时的 tag 和时刻（只读） */
export function rangSnapshot(): RangMap {
  return view;
}
const subscribeRang = (fn: () => void): (() => void) => {
  rangSubs.add(fn);
  return () => rangSubs.delete(fn);
};
/** 同上，变了重新渲染（“错过的提醒”用） */
export function useRangView(): RangMap {
  return useSyncExternalStore(subscribeRang, rangSnapshot, rangSnapshot);
}
