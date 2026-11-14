// 电脑版详情抽屉的外壳（B4 视觉验收 A1 的随手记抽屉；B6 返工抽成 kit，随手记页、今天页共用一套。皮肤视觉稿 DK.mason / NOTE_ED：边上浮起的圆角面板）
// • Esc 关（浮层 radix 开着时、输入法组字时不关）；“×”由里面的编辑器放（DrawerClose），点了调 onClose
// • 焦点：打开时记下原来的焦点，移到 initial 选出的元素（没有、或禁用了就移到抽屉本身）；关上（Esc、“×”、窗口变窄卸载）时还回去——
//   一直是同一条就还给原来的元素（不在了再用 refocus 找这一条在列表里的按钮）；中途换过一条，先用 refocus 找当前这一条，找不到再退回原来的元素
// • 读屏：aside 带名字；不加 aria-modal（侧栏和列表照样能用）
// • side：在哪边（默认右边，左边时贴着侧栏右沿）；handle：kit DeskLayout 给的换边把手，放在抽屉最上面
// • 升级中心的 busy（不出版本横幅、不自动重新载入）：焦点在抽屉里（含抽屉里弹出的 radix 浮层）时才占，点回列表、侧栏就放开。
//   抽屉在电脑上可能开一整天，一直占着新版本永远不出（B6 独立评审第 12 条）；里面的编辑器在抽屉模式下自己不占（EditShell、NoteEditor）
// • 在不在抽屉里只有一种判断：useInDrawer()（抽屉往里传 onClose；不在抽屉里是 null）。编辑器靠它决定画“×”还是“‹ 返回”、占不占 busy
import { createContext, useContext, useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { useHoldBusy } from '../hooks/useHoldBusy.ts';
import styles from './DetailDrawer.module.css';

const InDrawer = createContext<(() => void) | null>(null);

/** 在详情抽屉里时是关抽屉的函数（“×”用），不在抽屉里是 null */
export const useInDrawer = (): (() => void) | null => useContext(InDrawer);

export interface DetailDrawerProps {
  /** 当前打开的是哪一条（换一条时重新移焦点） */
  id: string;
  label: string;
  onClose(): void;
  side?: 'left' | 'right' | undefined;
  handle?: ReactNode;
  /** 打开时焦点落在哪（抽屉里的选择器）；不给就落在抽屉本身 */
  initial?: string | undefined;
  /** 关上时找这一条在列表里的按钮（原来的焦点不在了、或中途换过一条时用） */
  refocus(id: string): HTMLElement | null;
  'data-testid': string;
  children: ReactNode;
}

export function DetailDrawer({ id, label, onClose, side, handle, initial, refocus, 'data-testid': testId, children }: DetailDrawerProps) {
  const box = useRef<HTMLElement>(null);
  const opener = useRef<Element | null | undefined>(undefined);
  if (opener.current === undefined) opener.current = document.activeElement;
  const [inside, setInside] = useState(false);
  useHoldBusy('editing', inside);
  /** 焦点去了抽屉外面（radix 浮层挂在 body 下，算抽屉里） */
  const onBlur = (e: FocusEvent<HTMLElement>): void => {
    const to = e.relatedTarget;
    if (!(to instanceof Element && (e.currentTarget.contains(to) || to.closest('[data-radix-popper-content-wrapper]')))) setInside(false);
  };
  const firstId = useRef(id);
  const cur = useRef({ id, refocus });
  cur.current = { id, refocus };
  // 里面的编辑器是按需下载的（今天页抽屉里的随手记）：initial 选出的元素还没画出来时焦点先落在抽屉本身，等它出来再挪过去（这期间焦点被挪走了就不抢）
  useEffect(() => {
    const root = box.current;
    if (!root) return;
    const pick = (): HTMLElement | null => {
      const el = initial ? root.querySelector<HTMLElement>(initial) : null;
      return el && !(el as HTMLInputElement).disabled ? el : null;
    };
    const el = pick();
    (el ?? root).focus();
    if (el || !initial) return;
    const mo = new MutationObserver(() => {
      const later = pick();
      if (!later) return;
      mo.disconnect();
      if (document.activeElement === root) later.focus();
    });
    mo.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    return () => mo.disconnect();
  }, [id, initial]);
  // prettier-ignore
  useEffect(() => () => {
    const el = opener.current, { id: now, refocus: find } = cur.current;
    const orig = el instanceof HTMLElement && el.isConnected && el !== document.body ? el : null;
    const mine = find(now);
    (now === firstId.current ? orig ?? mine : mine ?? orig)?.focus();
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.querySelector('[data-radix-popper-content-wrapper]')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside
      ref={box}
      className={styles.drawer}
      data-side={side === 'left' ? 'left' : undefined}
      tabIndex={-1}
      aria-label={label}
      data-testid={testId}
      onFocus={() => setInside(true)}
      onBlur={onBlur}
    >
      {handle}
      <InDrawer.Provider value={onClose}>{children}</InDrawer.Provider>
    </aside>
  );
}

/** 抽屉右上角的“×”（随手记、日程、待办的抽屉同一个） */
export function DrawerClose({ label, onClick, testId }: { label: string; onClick(): void; testId: string }) {
  return (
    <button type="button" className={styles.close} onClick={onClick} aria-label={label} data-testid={testId}>
      ×
    </button>
  );
}
