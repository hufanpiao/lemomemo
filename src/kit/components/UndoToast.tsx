// 撤销提示条（B2 FA-2；定稿线框“撤销条”，R-122、R-145：半透明磨砂，和提示条同一套；44px 点击区）
// 用法：删除、批量改动后出一条“已删除 · 撤销”；ms 后自动收起（默认 8 秒，线框低 4 同一个时长）；点了撤销或收起都只回调一次
// • role="status"：读屏会读出文字，但不抢焦点（不打断正在做的事）
// • 鼠标悬停、键盘焦点在条上时暂停计时，移开后重新计 ms（读屏用户来得及按到“撤销”）
// • 只渲染，不碰数据：撤销做什么由调用方给 onUndo
import { useEffect, useRef, useState } from 'react';
import styles from './UndoToast.module.css';

export const UNDO_TOAST_MS = 8000;

export interface UndoToastProps {
  message: string;
  undoLabel: string;
  onUndo(): void;
  /** 收起（到时、或点了撤销之后）；只调一次 */
  onClose(): void;
  ms?: number;
  'data-testid'?: string;
}

export function UndoToast({ message, undoLabel, onUndo, onClose, ms = UNDO_TOAST_MS, 'data-testid': testId }: UndoToastProps) {
  const [paused, setPaused] = useState(false);
  const done = useRef(false);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    if (paused) return undefined;
    const t = setTimeout(() => {
      if (done.current) return;
      done.current = true;
      close.current();
    }, ms);
    return () => clearTimeout(t);
  }, [paused, ms]);

  const undo = () => {
    if (done.current) return;
    done.current = true;
    onUndo();
    close.current();
  };

  return (
    <div
      className={styles.toast}
      role="status"
      data-testid={testId}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className={styles.msg}>{message}</span>
      <button type="button" className={styles.undo} onClick={undo} data-testid={testId ? `${testId}-undo` : undefined}>
        {undoLabel}
      </button>
    </div>
  );
}
