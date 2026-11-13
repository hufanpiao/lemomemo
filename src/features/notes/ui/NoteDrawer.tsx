// 随手记电脑详情抽屉（B4 视觉验收 A1；皮肤视觉稿 DK.mason / NOTE_ED：右边浮起、盖在面板上面）：外壳从 NoteEditPage.tsx 拆出来（文件不超过 300 行）
// • Esc 或“×”关；浮层（radix）开着时、输入法组字时 Esc 不关
// • 焦点：打开时记下原来的焦点、移到正文框；关上（Esc、“×”、窗口变窄自动关）时还回去，原来的元素不在了就找这一条的卡片或行上的按钮
// • 读屏：aside 名字“随手记详情”；不加 aria-modal（侧栏和列表照样能用）
// • 电脑版（B6，5.9b）：side 是抽屉在哪边（默认右边），handle 是 kit DeskLayout 给的换边把手，放在抽屉最上面
import { useEffect, useRef, type ReactNode } from 'react';
import { useNotesT } from '../hooks/useNotesT.ts';
import { NoteEditor } from './NoteEditPage.tsx';
import styles from './NoteEditPage.module.css';

/** 电脑上的详情抽屉：从右边滑出，Esc 或“×”关（浮层开着时、输入法组字时 Esc 不关）。
 *  焦点：打开时记下原来的焦点、移到正文框；关上（Esc、“×”、窗口变窄自动关）时还回去——一直是这一条就还给原来的元素（不在了再找卡片或行上的按钮）；
 *  中途换过一条，先找当前这一条的卡片或行按钮，找不到再退回原来的元素 */
export function NoteDrawer({ id, onClose, side, handle }: { id: string; onClose(): void; side?: 'left' | 'right' | undefined; handle?: ReactNode }) {
  const t = useNotesT();
  const box = useRef<HTMLElement>(null);
  const opener = useRef<Element | null | undefined>(undefined);
  if (opener.current === undefined) opener.current = document.activeElement;
  const firstId = useRef(id);
  const idRef = useRef(id);
  idRef.current = id;
  useEffect(() => {
    const body = box.current?.querySelector<HTMLTextAreaElement>('[data-testid="note-edit-body"]');
    (body && !body.disabled ? body : box.current)?.focus();
  }, [id]);
  // prettier-ignore
  useEffect(() => () => {
    const el = opener.current, cur = idRef.current;
    const orig = el instanceof HTMLElement && el.isConnected && el !== document.body ? el : null;
    const mine = document.querySelector<HTMLElement>(`[data-testid="notes-card-${cur}"] button, [data-testid="notes-row-${cur}"] button`);
    (cur === firstId.current ? orig ?? mine : mine ?? orig)?.focus();
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
    <aside ref={box} className={styles.drawer} data-side={side === 'left' ? 'left' : undefined} tabIndex={-1} aria-label={t('note.edit.drawer', {})} data-testid="note-drawer">
      {handle}
      <NoteEditor key={id} id={id} onClose={onClose} drawer />
    </aside>
  );
}
