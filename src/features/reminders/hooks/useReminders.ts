// 提醒功能的 hooks（B2 FA-4；架构 5.3、5.9、4.3“时钟偏差”K8-clock）
// • “现在”一律用 platform/clock 的 clock.now()（服务器校正过的时间），本机提醒判断、倒计时都用它
// • useReminderList：从本机的 events、todos、settings 现算所有提醒（remindAtOf 和服务器同一份，TC-B2-29）
// • useRemindEngine：挂在 App 上（RemindHost）跑一份——每分钟算一次正在响的放进 kit 的队列；键盘弹起时压住横幅；
//   exe 每分钟检查交 showLocalReminder 弹、别处处理了 closeLocalReminder 撤回（不写 pushed_for）；打开 App、回到前台时用 getNotifications() 关掉已处理的通知
// • useRemindActions：知道了、稍后（写 notified_for / snooze_at，经 data/remind-write）、完成待办；处理完从队列拿掉，稍后弹 2 秒“15:25 再提醒你”
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { getBoot } from '../../../core/boot.ts';
import { savePatch } from '../../../core/edit-save.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { pruneCollapsed, remindQueue, removeRinging, resetRemindQueue, setRinging, setSnoozeNote, holdReminders, useRemindQueue } from '../../../kit/state/remind-queue.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { closeLocalReminder, showLocalReminder } from '../../../platform/native-bridge.ts';
import { closeHandledNotifications } from '../../../platform/notifications.ts';
import { watchKeyboard } from '../../../platform/viewport.ts';
import { actionsFor, type RemindAction } from '../../../../shared/logic/remind-actions.ts';
import { localDue, localText, shouldCloseShown, shownKey, staleShown } from '../data/local-notify.ts';
import { allReminders, MISSED_WINDOW_MS, occurrenceKey, ringing, type Rang, type RangMap, type Reminder, type Row } from '../data/reminder-model.ts';
import { ackAll as ackAllWrite, ackReminder, snoozeReminder, timingPending, type OutboxLikeItem, type SaveOutcome } from '../data/remind-write.ts';
import { defaultTimeOf, dndOf, KEY_DEFAULT_TIME, KEY_DND, KEY_SHOW_TITLE, settingValue, showTitleOf, type SettingRow } from '../data/remind-settings.ts';

const MIN = 60_000;
/** “15:25 再提醒你”停留多久 */
export const SNOOZE_NOTE_MS = 2_000;

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
function ackLocally(tag: string): void {
  setSessionAcked(new Set([...sessionAcked, tag]));
}
function clearSessionAcked(): void {
  laterAcks.clear();
  if (sessionAcked.size > 0) setSessionAcked(new Set());
}
const markSessionAcked = (list: Reminder[], acked: ReadonlySet<string>): Reminder[] =>
  acked.size === 0 ? list : list.map((r) => (acked.has(r.tag) && !r.handled ? { ...r, handled: true } : r));

/**
 * 只在本机了结、等那条改动发出去以后补写的“知道了”（第三轮 L10）：tag → 这一条和当时的提醒时刻。
 * 引擎监听 outbox，这一行不再 timingPending 时，提醒时刻还是当时那个（同一次提醒）就补写一次 ackPatch；变了（换成另一次了）就不写、丢掉
 */
const laterAcks = new Map<string, { kind: Reminder['kind']; id: string; remindAt: number | null }>();

/** outbox 里还没上服务器的项；没启动、读不到时当没有 */
async function outboxItems(): Promise<readonly OutboxLikeItem[]> {
  const ob = getBoot()?.outbox as { list?: () => Promise<readonly OutboxLikeItem[]> } | undefined;
  try {
    return typeof ob?.list === 'function' ? await ob.list() : [];
  } catch {
    return [];
  }
}

/** “知道了”在本机了结（R4-L1）：不写服务器，关横幅、撤本机通知、记进本次会话的已处理集合 */
function ackOnlyHere(r: Reminder): void {
  laterAcks.set(r.tag, { kind: r.kind, id: r.id, remindAt: r.remindAt });
  ackLocally(r.tag);
  removeRinging(r.tag);
  void closeLocalReminder(r.tag).catch(() => undefined);
}

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

/** 这一条的按钮（按 current_tz、免打扰、remind.default_time） */
export function actionsOf(r: Reminder, now: number, tz: string, prefs: { dnd: ReturnType<typeof dndOf>; defaultTime: string }): RemindAction[] {
  const opts = { dnd: prefs.dnd, defaultTime: prefs.defaultTime };
  if (r.kind === 'todo') return actionsFor(r.row, 'todo', now, tz, opts);
  const date = typeof r.row['date'] === 'string' ? r.row['date'] : '';
  const time = typeof r.row['time'] === 'string' ? r.row['time'] : null;
  const rtz = typeof r.row['tz'] === 'string' ? r.row['tz'] : null;
  return actionsFor({ date, time, tz: rtz }, 'event', now, tz, opts);
}

/** 挂在 App 上跑一份：队列、键盘、本机通知、收回已处理的通知 */
/** 本次打开以后响过的（R-336）：引擎写、“错过的提醒”读；引擎卸载（退出登录、换账号）时清空 */
const rangStore = new Map<string, Rang>();
/** 给“错过的提醒”用：本次打开以后响过的 occurrenceKey → 当时的 tag 和时刻 */
export function rangSnapshot(): RangMap {
  return rangStore;
}

export function useRemindEngine(): void {
  const now = useMinuteNow();
  const { list, tz, prefs, known } = useReminderList(now);
  const locale = useUi((s) => s.locale);
  const since = useRef(clock.now());
  const collapsed = useRemindQueue((s) => s.collapsed);
  // 本次打开以后响过的：occurrenceKey → 当时的 tag 和实际响的时刻。全天日程改了 remind.default_time，同一次提醒不再进横幅，
  // 没按“知道了”的进“错过的提醒”按当时的时刻显示（R-336 ②；重开 App 会忘，见 REMIND-shown-persist）
  // 只在本机了结的“知道了”：那条改动发出去以后，提醒时刻没变的补写一次（第三轮 L10）
  const listRef = useRef(list);
  listRef.current = list;
  useEffect(() => {
    const ob = getBoot()?.outbox as { subscribe?: (fn: () => void) => () => void } | undefined;
    if (typeof ob?.subscribe !== 'function') return;
    // alive（第四轮 L13）：引擎卸载（退出登录、换账号）后，卡在 await 上的那次醒来不再拿旧账号的行补写；每次 await 之后都查
    let alive = true;
    let busy = false;
    // dirty（第四轮 L14）：正在跑时又来了 outbox 通知，记下来，跑完再跑一次，不等下一次变化
    let dirty = false;
    const flush = async (): Promise<void> => {
      if (busy) {
        dirty = true;
        return;
      }
      if (!alive || laterAcks.size === 0) return;
      busy = true;
      try {
        const items = await outboxItems();
        if (!alive) return;
        for (const [tag, p] of [...laterAcks]) {
          if (timingPending(p, items)) continue;
          laterAcks.delete(tag);
          const r = listRef.current.find((x) => x.kind === p.kind && x.id === p.id);
          if (r && r.remindAt !== null && r.remindAt === p.remindAt && r.row['notified_for'] !== r.remindAt) {
            await ackReminder(r, clock.now()).catch(() => undefined);
            if (!alive) return;
          }
        }
      } finally {
        busy = false;
        if (dirty && alive) {
          dirty = false;
          void flush();
        }
      }
    };
    const off = ob.subscribe(() => void flush());
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(
    () => () => {
      rangStore.clear();
      clearSessionAcked();
    },
    [],
  );

  // 正在响的进队列（本次打开以后到点的；打开前就到点的进“错过的提醒”）
  useEffect(() => {
    const ring = ringing(list, now, since.current, collapsed, rangStore);
    for (const r of ring) if (!rangStore.has(occurrenceKey(r))) rangStore.set(occurrenceKey(r), { tag: r.tag, dueAt: r.dueAt });
    setRinging(ring.map((r) => ({ kind: r.kind, id: r.id, dueAt: r.tagDue, tag: r.tag })));
  }, [list, now, collapsed]);

  // 退出（RemindHost 卸载）时清空队列
  useEffect(() => () => resetRemindQueue(), []);

  // 键盘弹起时横幅先排队
  useEffect(() => {
    let release: (() => void) | null = null;
    const off = watchKeyboard((open) => {
      if (open && !release) release = holdReminders('keyboard');
      if (!open && release) {
        release();
        release = null;
      }
    });
    return () => {
      off();
      release?.();
    };
  }, []);

  // 收起记录只留 7 天（代码审查低 8）
  useEffect(() => {
    pruneCollapsed(now - MISSED_WINDOW_MS);
  }, [now]);

  // exe 每分钟检查：到点的弹本机通知（网页版 showLocalReminder 是空操作），别处处理了撤回
  // 弹过的：shownKey → 弹出时的 tag（全天日程改了默认时刻，key 不变、不再弹第二次，R-336；撤回仍按原来那条通知的 tag）
  const shown = useRef(new Map<string, string>());
  // 退出登录、换账号（RemindHost 卸载）时撤回本次弹出的本机通知（代码审查低 5；退出流程另有 closeAllLocalReminders 兜底）
  useEffect(
    () => () => {
      for (const tag of shown.current.values()) void closeLocalReminder(tag).catch(() => undefined);
      shown.current.clear();
    },
    [],
  );
  useEffect(() => {
    for (const [key, tag] of staleShown(shown.current, list)) {
      shown.current.delete(key);
      void closeLocalReminder(tag).catch(() => undefined);
    }
    for (const r of localDue(list, now, shown.current)) {
      shown.current.set(shownKey(r), r.tag);
      const text = localText(r, { showTitle: prefs.showTitle, tz, locale, defaultTime: prefs.defaultTime });
      void showLocalReminder({ tag: r.tag, kind: r.kind, id: r.id, dueAt: r.tagDue, title: text.title, body: text.body }).catch(() => undefined);
    }
  }, [list, now, prefs.showTitle, prefs.defaultTime, tz, locale]);

  // 打开 App、回到前台：关掉已处理的系统通知（iPhone 不发 resolve，5.3）；本机还没拉到的行不动
  const latest = useRef({ list, known, tz });
  latest.current = { list, known, tz };
  useEffect(() => {
    const run = (): void => {
      const { list: l, known: k, tz: z } = latest.current;
      if (k.size === 0) return;
      void closeHandledNotifications((t) => shouldCloseShown(t, l, k.has(`${t.kind}:${t.id}`), z));
    };
    const onVis = (): void => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  const ranOnce = useRef(false);
  useEffect(() => {
    if (ranOnce.current || known.size === 0) return;
    ranOnce.current = true;
    void closeHandledNotifications((t) => shouldCloseShown(t, list, known.has(`${t.kind}:${t.id}`), tz));
  }, [list, known, tz]);
}

export type ActResult = 'ok' | 'failed' | 'readonly' | 'silent';
const resultOf = (r: SaveOutcome): ActResult => (r === 'saved' ? 'ok' : r === 'readonly' ? 'readonly' : r === 'switching' ? 'silent' : 'failed');

/** 知道了、稍后、完成待办 */
export function useRemindActions() {
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (noteTimer.current) clearTimeout(noteTimer.current);
    },
    [],
  );

  const prefs = useRemindPrefs();
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  const act = useCallback(async (r: Reminder, shown: RemindAction): Promise<ActResult> => {
    const now = clock.now();
    // 按点按那一刻重新算时刻（代码审查低 1）：按钮可能是几分钟前渲染的，“10 分钟后”要从现在起算；这一刻已经没有这个按钮了（如离开始不到 60 秒）就按原样
    const a = actionsOf(r, now, currentTz(), prefsRef.current).find((x) => x.key === shown.key) ?? shown;
    if (a.key === 'genTodo') return 'failed';   // 纪念日（B5）
    if (a.key === 'ack') {
      if (timingPending(r, await outboxItems())) {
        ackOnlyHere(r);
        return 'ok';
      }
      const res = resultOf(await ackReminder(r, now));
      if (res === 'ok') removeRinging(r.tag);
      return res;
    }
    if (a.at === null) return 'failed';
    const res = resultOf(await snoozeReminder(r, a.at, now));
    if (res === 'ok') {
      removeRinging(r.tag);
      setSnoozeNote(a.at);
      if (noteTimer.current) clearTimeout(noteTimer.current);
      noteTimer.current = setTimeout(() => {
        if (remindQueue.getState().snoozeNote === a.at) setSnoozeNote(null);
      }, SNOOZE_NOTE_MS);
    }
    return res;
  }, []);

  /** 待办横幅、整页提醒标题前的完成圆圈（UI-2 第三轮中 1） */
  const complete = useCallback(async (r: Reminder): Promise<ActResult> => {
    if (r.kind !== 'todo') return 'failed';
    const now = clock.now();
    const res = resultOf(await savePatch('todos', r.id, { done: true, done_at: now, updated_at: now }, true));
    if (res === 'ok') removeRinging(r.tag);
    return res;
  }, []);

  /** “全部知道了”：返回没写进去的条数；只把写进去的从队列拿掉（代码审查低 2） */
  const ackAll = useCallback(async (list: readonly Reminder[]): Promise<number> => {
    const items = await outboxItems();
    const here = list.filter((r) => timingPending(r, items));
    for (const r of here) ackOnlyHere(r);
    const rest = list.filter((r) => !here.includes(r));
    const ok = await ackAllWrite(rest, clock.now());
    for (const tag of ok) removeRinging(tag);
    return rest.length - ok.length;
  }, []);

  return { act, complete, ackAll };
}
