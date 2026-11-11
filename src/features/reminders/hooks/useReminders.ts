// 提醒功能的 hooks（B2 FA-4；架构 5.3、5.9、4.3“时钟偏差”K8-clock）
// • “现在”一律用 platform/clock 的 clock.now()（服务器校正过的时间），本机提醒判断、倒计时都用它
// • useReminderList：从本机的 events、todos、settings 现算所有提醒（remindAtOf 和服务器同一份，TC-B2-29）
// • useRemindEngine：挂在 App 上（RemindHost）跑一份——每分钟算一次正在响的放进 kit 的队列；键盘弹起时压住横幅；
//   挂上时先读本机库里“这一次响过没有”的记录（REMIND-shown-persist，data/remind-seen.ts），再算出第一份“响过”快照（本机记录 + 服务器 pushed_for 推导），
//   两步做完才 armed（kit 的 armedSince；今天页等它才挂“错过的提醒”，修订 1 P2）；新记下的每分钟最多写回一次，本机弹过系统通知的马上写，
//   页面藏起、关掉（pagehide、visibilitychange 变成 hidden）时补写一次；
//   exe 每分钟检查交 showLocalReminder 弹、别处处理了 closeLocalReminder 撤回（不写 pushed_for）；打开 App、回到前台时用 getNotifications() 关掉已处理的通知
// • useRemindActions：知道了、稍后（写 notified_for / snooze_at，经 data/remind-write）、完成待办；处理完从队列拿掉，稍后弹 2 秒“15:25 再提醒你”
import { useCallback, useEffect, useRef, useState } from 'react';
import { getBoot } from '../../../core/boot.ts';
import { actionResult, type ActionResult as ActResult } from '../../../core/action-result.ts';
import { savePatch } from '../../../core/edit-save.ts';
import { useMinuteNow } from '../../../kit/hooks/useMinuteNow.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { pruneCollapsed, remindQueue, removeRinging, resetRemindQueue, setRemindArmed, setRinging, setSnoozeNote, holdReminders, useRemindQueue } from '../../../kit/state/remind-queue.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { clock } from '../../../platform/clock.ts';
import { closeLocalReminder, showLocalReminder } from '../../../platform/native-bridge.ts';
import { closeHandledNotifications } from '../../../platform/notifications.ts';
import { isKeyboardOpen, watchKeyboard } from '../../../platform/viewport.ts';
import { actionsFor, type RemindAction } from '../../../../shared/logic/remind-actions.ts';
import { localDue, localText, shouldCloseShown, shownKey, staleShown } from '../data/local-notify.ts';
import { MISSED_WINDOW_MS, occurrenceKey, ringing, type Reminder } from '../data/reminder-model.ts';
import { ackAll as ackAllWrite, ackReminder, snoozeReminder, timingPending, type OutboxLikeItem } from '../data/remind-write.ts';
import type { dndOf } from '../data/remind-settings.ts';
import { rangView, readSeen, writeSeen } from '../data/remind-seen.ts';
import { ackLocally, clearRang, clearSessionAcked as clearAckedHere, loadRang, putBackDirtyRang, recordRang, setPushedRang, takeDirtyRang, useRangView, useReminderList, useRemindPrefs } from './remind-list.ts';

// 算列表那一部分拆到 remind-list.ts（首屏瘦身 H1 第三轮），别处照旧从这里引
export { rangSnapshot, useReminderList, useRemindPrefs } from './remind-list.ts';

/** “15:25 再提醒你”停留多久 */
export const SNOOZE_NOTE_MS = 2_000;

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

/** 清空本次会话只在本机处理过的（引擎卸载时） */
function clearSessionAcked(): void {
  laterAcks.clear();
  clearAckedHere();
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

/**
 * since：从哪一刻起到点的算“本次打开以后”（进横幅），之前到点的进“错过的提醒”。
 * App 等首屏画完、浏览器空闲才挂 RemindHost（首屏减重 ⑥），挂得比打开晚；since 由 App 在第一次渲染时记下传进来，
 * 打开到挂上之间到点的照样响（只是晚响这么一会儿）。没传时用挂载的时刻（测试、单独挂）
 */
export function useRemindEngine(sinceAt?: number): void {
  const now = useMinuteNow();
  const { list, tz, prefs, known } = useReminderList(now);
  const locale = useUi((s) => s.locale);
  const since = useRef(sinceAt ?? clock.now());
  const collapsed = useRemindQueue((s) => s.collapsed);
  // 响过的：occurrenceKey → 当时的 tag 和实际响的时刻（本机记录 + 服务器推导）。全天日程改了 remind.default_time，同一次提醒不再进横幅，
  // 没按“知道了”的进“错过的提醒”按当时的时刻显示（R-336 ②）；重开 App 从本机库读回来（REMIND-shown-persist）
  const rang = useRangView();
  // 弹过的本机通知：shownKey → 弹出时的 tag（见下面 exe 那一段）；本机库里 local 的记录挂上时灌进来，重开 App 也不再弹第二次
  const shown = useRef(new Map<string, string>());
  // loaded：本机记录读完了（读失败当空的）；armed：第一份快照也算好了，才开始排横幅、弹本机通知，才告诉别的页面 armed
  const [loaded, setLoaded] = useState(false);
  const [armed, setArmed] = useState(false);
  // 挂上那一刻的本机库（换账号时这一份引擎会卸载；写回只写这一个库，不按 getBoot() 现取，免得写进下一个账号的库）
  const cacheRef = useRef(getBoot()?.cache ?? null);
  const flushSeen = useCallback((): void => {
    const add = takeDirtyRang();
    if (Object.keys(add).length === 0) return;
    void writeSeen(cacheRef.current, add, clock.now()).then((ok) => {
      if (!ok) putBackDirtyRang(add); // 写失败下一次再试
    });
  }, []);
  useEffect(() => {
    let alive = true;
    void readSeen(cacheRef.current).then((items) => {
      if (!alive) return;
      loadRang(items);
      for (const [k, x] of Object.entries(items)) if (x.local) shown.current.set(k, x.tag);
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);
  // 服务器那一半（pushed_for 推导）：读完本机记录后、列表变了、每分钟各算一次；第一份算好才 armed
  useEffect(() => {
    if (!loaded) return;
    let alive = true;
    void outboxItems().then((items) => {
      if (!alive) return;
      setPushedRang(rangView(list, new Map(), items, tz));
      setArmed(true);
    });
    return () => {
      alive = false;
    };
  }, [loaded, list, now, tz]);
  // 每分钟最多写回一次；页面藏起、关掉时补写（React 关页面时不卸载，L2）
  useEffect(() => {
    if (armed) flushSeen();
  }, [armed, now, flushSeen]);
  useEffect(() => {
    const onHide = (): void => {
      if (document.visibilityState === 'hidden') flushSeen();
    };
    addEventListener('pagehide', flushSeen);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      removeEventListener('pagehide', flushSeen);
      document.removeEventListener('visibilitychange', onHide);
    };
  }, [flushSeen]);
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
    // 挂上时先补写一次（首屏减重 ⑥）：引擎晚挂，挂上之前在整页提醒里只在本机了结的、那条改动已经发出去了的，不用等下一次 outbox 变化
    void flush();
    return () => {
      alive = false;
      off();
    };
  }, []);

  useEffect(
    () => () => {
      clearRang();
      clearSessionAcked();
    },
    [],
  );

  // 正在响的进队列（本次打开以后到点的；打开前就到点的进“错过的提醒”）
  useEffect(() => {
    if (!armed) return;
    const ring = ringing(list, now, since.current, collapsed, rang);
    for (const r of ring) recordRang(occurrenceKey(r), { tag: r.tag, dueAt: r.dueAt });
    setRinging(ring.map((r) => ({ kind: r.kind, id: r.id, dueAt: r.tagDue, tag: r.tag })));
  }, [armed, list, now, collapsed, rang]);

  // 告诉别的页面“引擎挂上了”（kit 的 armedSince）：读完本机记录、算好第一份快照以后（修订 1 P2）；今天页等它才挂“错过的提醒”
  // （REMIND-missed-flash）。卸载时清掉
  useEffect(() => {
    if (!armed) return;
    setRemindArmed(since.current);
    return () => setRemindArmed(null);
  }, [armed]);

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
    // 挂载时键盘已经弹着（首屏减重 ⑥：引擎晚挂，用户可能已经在打字）：先排队。watchKeyboard 订阅时量过一次，这里读到的是现在的
    if (isKeyboardOpen() && !release) release = holdReminders('keyboard');
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
  // 弹过的（shown，上面声明）：shownKey → 弹出时的 tag（全天日程改了默认时刻，key 不变、不再弹第二次，R-336；撤回仍按原来那条通知的 tag）；
  // 服务器推过、tag 已经变了的那一次也不弹（rang 里有、tag 不同）；tag 相同、只是服务器推过的照旧弹（R-52 两边都响）
  // 退出登录、换账号（RemindHost 卸载）时撤回本次弹出的本机通知（代码审查低 5；退出流程另有 closeAllLocalReminders 兜底）
  useEffect(
    () => () => {
      for (const tag of shown.current.values()) void closeLocalReminder(tag).catch(() => undefined);
      shown.current.clear();
    },
    [],
  );
  useEffect(() => {
    if (!armed) return;
    for (const [key, tag] of staleShown(shown.current, list)) {
      shown.current.delete(key);
      void closeLocalReminder(tag).catch(() => undefined);
    }
    let popped = false;
    for (const r of localDue(list, now, shown.current, rang)) {
      const key = shownKey(r);
      shown.current.set(key, r.tag);
      popped = recordRang(key, { tag: r.tag, dueAt: r.dueAt }, true) || popped;
      const text = localText(r, { showTitle: prefs.showTitle, tz, locale, defaultTime: prefs.defaultTime });
      void showLocalReminder({ tag: r.tag, kind: r.kind, id: r.id, dueAt: r.tagDue, occurrenceKey: key, title: text.title, body: text.body }).catch(() => undefined);
    }
    if (popped) flushSeen(); // 本机弹过的马上写（L2；次数很少）
  }, [armed, list, now, rang, prefs.showTitle, prefs.defaultTime, tz, locale, flushSeen]);

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

export type { ActResult };

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
      const res = actionResult(await ackReminder(r, now));
      if (res === 'ok') removeRinging(r.tag);
      return res;
    }
    if (a.at === null) return 'failed';
    const res = actionResult(await snoozeReminder(r, a.at, now));
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
    const res = actionResult(await savePatch('todos', r.id, { done: true, done_at: now, updated_at: now }, true));
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
