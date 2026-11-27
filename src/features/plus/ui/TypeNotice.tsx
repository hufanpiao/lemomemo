// 打字条记下以后的“已记下 · 撤销”提示条，外挂在打字条外面：TypeBarPreload 里一直挂一份，打字条收起就直接卸掉，提示条不跟着走
// • 照模块里那一批画（hooks/useTypeBar 的 useTypeNotice → data/type-batch.ts）：一条满 8 秒自动收起、仍可撤销；确认行在问时不出
// • 换页（路由名变了，等新页面显示出来，和 App 收打字条同一时机）、换到没有“＋”的页（这里跟着 TypeBarPreload 卸掉）：关掉提示条
// • 打字条开着时提示条抬到打字条上方（两者都贴 --dock-bottom，不抬会被打字条压住、点不到）：
//   打字条用 useNoticeLift 量自己的高度报上来，这里写进外壳（display: contents）的 --type-lift（CSSOM，不是内联 style 属性，CSP 照样过），
//   提示条只用 transform 往上抬“打字条高 + LIFT_GAP_PX”；打字条变高（确认行、两行提示）跟着走，打字条卸掉就清掉、回到底栏上方。
//   位置变化 110ms（calc(var(--dur-ui) / 2)）ease-out、只动 transform，系统或 App 里“减少动态”时直接到位（TypeBar.module.css .noticeSlot）
// • 提示条还在时 Ctrl+Z 撤销这一批；焦点在有字的输入框里时让给浏览器撤销打字
import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { createSignal } from '../../../../shared/core/signal.ts';
import { useRoute } from '../../../app/router.ts';
import { useKeys } from '../../../kit/hooks/layers.ts';
import { opensKeyboard } from '../../../platform/env.ts';
import { useTypeNotice } from '../hooks/useTypeBar.ts';
import { SavedNotice } from './SavedNotice.tsx';
import styles from './TypeBar.module.css';

/** 打字条开着时提示条和打字条顶端之间留的空（px） */
export const LIFT_GAP_PX = 8;

/** 打字条现在多高（加上 LIFT_GAP_PX）；没挂着为 null */
let lift: number | null = null;
const lifted = createSignal();
const setLift = (v: number | null): void => {
  if (v === lift) return;
  lift = v;
  lifted.emit();
};
const liftNow = (): number | null => lift;

/** 打字条挂着时调：量自己的高度报给提示条，变高跟着报，卸掉清掉 */
export function useNoticeLift(bar: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = bar.current;
    if (!el) return undefined;
    const put = (): void => setLift(Math.round(el.getBoundingClientRect().height) + LIFT_GAP_PX);
    put();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(put);
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      setLift(null);
    };
  }, [bar]);
}

/** 焦点在有字的输入框、文本框，或可编辑区里：Ctrl+Z 让给浏览器撤销打字 */
function hasTyping(el: EventTarget | null): boolean {
  if (!opensKeyboard(el)) return false;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value !== '';
  return el.isContentEditable;
}

export function TypeNotice() {
  const { notice, acts, onEdit } = useTypeNotice(useRoute().name);
  const h = useSyncExternalStore(lifted.subscribe, liftNow, liftNow);
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = slot.current;
    if (!box) return;
    if (h === null) box.style.removeProperty('--type-lift');
    else box.style.setProperty('--type-lift', `${h}px`);
  }, [h]);
  useKeys({
    'mod+z': (e) => {
      if (!notice || hasTyping(e.target)) return false;
      void acts.undo();
      return true;
    },
  });
  return (
    <div ref={slot} className={styles.noticeSlot}>
      {notice ? <SavedNotice notice={notice} acts={acts} onEdit={onEdit} /> : null}
    </div>
  );
}
