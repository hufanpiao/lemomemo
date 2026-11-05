// 宿主拿数据和动作只经这里（L5，同 reminders 的 useUnsynced）：gate 的 store 快照、当前路由下要不要藏、冲突卡的自动收起计时
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useRoute } from '../../../app/router.ts';
import { UNDO_TOAST_MS } from '../../../kit/components/UndoToast.tsx';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { describeConflict, type FieldLine } from '../data/fields.ts';
import type { ConflictNotice, NoticeSnapshot, SyncNoticeStore } from './notice-types.ts';
import { tSn, type SnKey } from './useSnT.ts';

/** 告知页（ConsentPage，路由 onboarding）、整页提醒（#/remind）不显示提示卡，卡先排队（L4） */
const HIDE_ON: readonly string[] = ['onboarding', 'remind'];
/** 计时的步长：每一步看一次能不能走（页面可见、没有别的弹层、不在告知页、指针和焦点都不在卡上） */
export const NOTICE_TICK_MS = 250;

export function useNoticeSnapshot(store: SyncNoticeStore): NoticeSnapshot {
  return useSyncExternalStore(store.subscribe, store.getState);
}

/** 当前路由下藏不藏（告知页不在 App 的路由里时由样式藏：body 里有 main[data-feature="onboarding"]） */
export function useRouteHidden(): boolean {
  return HIDE_ON.includes(useRoute().name);
}

/** 现在能不能计时：页面可见、<html> 上没有 scroll-locked（主 App 的弹层，或卡自己开的对话框）、没在告知页 */
export function canCount(doc: Document = document): boolean {
  if (doc.visibilityState !== 'visible') return false;
  if (doc.documentElement.classList.contains('scroll-locked')) return false;
  return doc.querySelector('main[data-feature="onboarding"]') === null;
}

/**
 * 冲突卡 8 秒后自动收起（同 UNDO_TOAST_MS，M3、M4）：只在卡显示着（active）、canCount()、指针和焦点都不在卡上时走；
 * 换了一张卡（key 变了）重新计，悬停、焦点也清掉。返回给卡挂的四个事件
 */
export function useAutoDismiss(key: string | null, active: boolean, onDone: (key: string) => void, ms = UNDO_TOAST_MS) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  // 换了卡（或卡没了）就清掉悬停、焦点（代码审查 K8 界面批 M3）：点“知道了”后卡直接卸掉，收不到 mouseleave、blur，
  // 不清的话之后的冲突卡永远不自动收起
  const [prevKey, setPrevKey] = useState(key);
  if (prevKey !== key) {
    setPrevKey(key);
    setHover(false);
    setFocus(false);
  }
  const done = useRef(onDone);
  done.current = onDone;
  const left = useRef(ms);
  useEffect(() => {
    left.current = ms;
  }, [key, ms]);
  useEffect(() => {
    if (key === null || !active || hover || focus) return undefined;
    const id = setInterval(() => {
      if (!canCount()) return;
      left.current -= NOTICE_TICK_MS;
      if (left.current <= 0) {
        clearInterval(id);
        done.current(key);
      }
    }, NOTICE_TICK_MS);
    return () => clearInterval(id);
  }, [key, active, hover, focus]);
  return {
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setFocus(true),
    onBlur: (e: { currentTarget: Element; relatedTarget: EventTarget | null }) => {
      if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setFocus(false);
    },
  };
}

/** 对话框里的各行（字段描述在 data/fields.ts；词典按当前语言从这里传进去） */
export function conflictLines(n: ConflictNotice, locale: Locale): FieldLine[] {
  return describeConflict(n.table, n.conflicts, n.old, locale, (k, p) => tSn(k as SnKey, p as never, locale));
}
