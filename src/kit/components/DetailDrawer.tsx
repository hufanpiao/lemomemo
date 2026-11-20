// 电脑版详情抽屉的外壳（B4 视觉验收 A1 的随手记抽屉；B6 返工抽成 kit，随手记页、今天页共用一套。皮肤视觉稿 DK.mason / NOTE_ED：边上浮起的圆角面板）
// • Esc 关：抽屉是层栈（kit/hooks/layers.ts）里的一层，只在它是栈顶时关（上面开着浮层、打字条、弹层时先关那些；输入法组字时不关）；“×”由里面的编辑器放（DrawerClose），点了调 onClose
// • 焦点：打开时（层栈入栈时）记下原来的焦点，移到 initial 选出的元素（没有、或禁用了就移到抽屉本身）；关上（Esc、“×”、窗口变窄卸载）时焦点在抽屉里、或掉到 body 就还回去（用户已经点到别处不抢）——
//   一直是同一条就还给原来的元素（不在了再找这一条在列表里的按钮）；中途换过一条，先找当前这一条的按钮，找不到再退回原来的元素。
//   列表里这一条的按钮统一认 data-open="<id>"（今天页、随手记页的行和卡片都带）；那一行也没了（删了、日子过了）退到页顶能接焦点的 h1（今天页的日期，tabIndex=-1），
//   焦点不掉到 body（独立评审第 10 条）
// • 读屏：aside 带名字；不加 aria-modal（侧栏和列表照样能用）
// • side：在哪边（默认右边，左边时贴着侧栏右沿）；handle：kit DeskLayout 给的换边把手，叠在抽屉左上角、和编辑器顶行同一行（R-436，视觉稿 .dtop）
// • 升级中心的 busy（不出版本横幅、不自动重新载入）：焦点在抽屉里（含抽屉里弹出的 radix 浮层）时才占，点回列表、侧栏就放开。
//   抽屉在电脑上可能开一整天，一直占着新版本永远不出（B6 独立评审第 12 条）；里面的编辑器在抽屉模式下自己不占（EditShell、NoteEditor）
// • 在不在抽屉里只有一种判断：useInDrawer()（抽屉往里传 onClose；不在抽屉里是 null）。编辑器靠它决定画“×”还是“‹ 返回”、占不占 busy
import { createContext, useContext, useEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { useEnter } from '../../motion/components.ts';
import { useLayer } from '../hooks/useLayer.ts';
import { useHoldBusy } from '../hooks/useHoldBusy.ts';
import styles from './DetailDrawer.module.css';

const InDrawer = createContext<(() => void) | null>(null);

/** 在详情抽屉里时是关抽屉的函数（“×”用），不在抽屉里是 null */
export const useInDrawer = (): (() => void) | null => useContext(InDrawer);

/** 这一条在列表里的按钮（data-open）；没有就页顶能接焦点的 h1 */
const rowOf = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`main [data-open="${id}"]`) ?? document.querySelector<HTMLElement>('main h1[tabindex]');

export interface DetailDrawerProps {
  /** 当前打开的是哪一条（换一条时重新移焦点；关上时找 data-open 是它的按钮） */
  id: string;
  label: string;
  onClose(): void;
  side?: 'left' | 'right' | undefined;
  handle?: ReactNode;
  /** 打开时焦点落在哪（抽屉里的选择器）；不给就落在抽屉本身 */
  initial?: string | undefined;
  'data-testid': string;
  children: ReactNode;
}

export function DetailDrawer({ id, label, onClose, side, handle, initial, 'data-testid': testId, children }: DetailDrawerProps) {
  const box = useRef<HTMLElement>(null);
  // 进场：从右边（换到左边时从左边）滑进来 24px 并淡入，减少动态效果时只淡入（motion 的 useEnter，数值在 motion/presets.ts 的 enters）；关上直接卸载
  const enter = useEnter(side === 'left' ? 'drawerLeft' : 'drawerRight', box);
  const [inside, setInside] = useState(false);
  useHoldBusy('editing', inside);
  /** 焦点去了抽屉外面（radix 浮层挂在 body 下，算抽屉里） */
  const onBlur = (e: FocusEvent<HTMLElement>): void => {
    const to = e.relatedTarget;
    if (!(to instanceof Element && (e.currentTarget.contains(to) || to.closest('[data-radix-popper-content-wrapper]')))) setInside(false);
  };
  const firstId = useRef(id);
  const cur = useRef(id);
  cur.current = id;
  // initial 选出的元素还没画出来、或还禁用着（编辑器在读这一行）时焦点先落在抽屉本身，等它出来再挪过去（这期间焦点被挪走了就不抢）
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
  // 抽屉是层栈里的一层（非模态，kit/hooks/layers.ts）：Esc 是栈顶时才关（上面开着浮层、打字条时先关那些）；关上时层栈按这里给的顺序还焦点
  useLayer(true, {
    name: 'drawer',
    el: () => box.current,
    onEsc: () => onClose(),
    // opener：打开它的元素（useLayer 在第一次渲染时记，早于里面编辑器在 layout 阶段挪焦点）
    back: (opener) => {
      const now = cur.current;
      const orig = opener instanceof HTMLElement && opener !== document.body ? opener : null;
      const mine = rowOf(now);
      return now === firstId.current ? [orig, mine] : [mine, orig];
    },
  });
  return (
    <aside
      ref={enter}
      className={styles.drawer}
      data-side={side === 'left' ? 'left' : undefined}
      tabIndex={-1}
      aria-label={label}
      data-testid={testId}
      onFocus={() => setInside(true)}
      onBlur={onBlur}
    >
      {handle ? <div className={styles.grip}>{handle}</div> : null}
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
