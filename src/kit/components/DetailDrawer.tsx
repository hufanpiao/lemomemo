// 电脑版详情抽屉的外壳（B4 视觉验收 A1 的随手记抽屉；B6 返工抽成 kit，随手记页、今天页共用一套。皮肤视觉稿 DK.mason / NOTE_ED：边上浮起的圆角面板）
// • Esc 关（浮层 radix 开着时、输入法组字时不关）；“×”由里面的编辑器放（DrawerClose），点了调 onClose
// • 焦点：打开时记下原来的焦点，移到 initial 选出的元素（没有、或禁用了就移到抽屉本身）；关上（Esc、“×”、窗口变窄卸载）时还回去——
//   一直是同一条就还给原来的元素（不在了再用 refocus 找这一条在列表里的按钮）；中途换过一条，先用 refocus 找当前这一条，找不到再退回原来的元素
// • 读屏：aside 带名字；不加 aria-modal（侧栏和列表照样能用）
// • side：在哪边（默认右边，左边时贴着侧栏右沿）；handle：kit DeskLayout 给的换边把手，放在抽屉最上面
import { useEffect, useRef, type ReactNode } from 'react';
import styles from './DetailDrawer.module.css';

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
  const firstId = useRef(id);
  const cur = useRef({ id, refocus });
  cur.current = { id, refocus };
  useEffect(() => {
    const el = initial ? box.current?.querySelector<HTMLElement>(initial) : null;
    (el && !(el as HTMLInputElement).disabled ? el : box.current)?.focus();
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
    <aside ref={box} className={styles.drawer} data-side={side === 'left' ? 'left' : undefined} tabIndex={-1} aria-label={label} data-testid={testId}>
      {handle}
      {children}
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
