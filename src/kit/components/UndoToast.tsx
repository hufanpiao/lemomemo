// 撤销提示条（B2 FA-2；定稿线框“撤销条”，R-122、R-145：半透明磨砂，和提示条同一套；44px 点击区）
// 用法：删除、批量改动后出一条“已删除 · 撤销”；ms 后自动收起（默认 8 秒，线框低 4 同一个时长）；点了撤销或收起都只回调一次
// • role="status"：读屏会读出文字，但不抢焦点（不打断正在做的事）
// • 鼠标悬停、键盘焦点在条上时暂停计时，移开后重新计 ms（读屏用户来得及按到“撤销”）
// • 只渲染，不碰数据：撤销做什么由调用方给 onUndo
// • 根元素带 data-undo-toast（K8 冲突提示 3.1，主持人已批）：冲突提示卡在撤销条开着时往上让一条
// • solo（B6 返工 11-14“两个撤销条不能叠在一起”）：带 solo 的条同一时间只留一条，被收起的照常回调 onClose、不撤销。分两种（独立评审第 7 条）：
//   'keep'：删除类（今天页、随手记、列表的删除撤销条），新出来就把别的 solo 条都收起——删掉的东西能撤销最要紧；
//   'yield'：电脑版布局的“布局已保存”，新出来只收起别的 yield 条；已经有 keep 条开着时让路、自己直接收起（布局还能从“⋯”恢复默认）。
//   冲突提示卡这类本来就和撤销条并存的不带 solo
import { useEffect, useRef, useState } from 'react';
import styles from './UndoToast.module.css';

export const UNDO_TOAST_MS = 8000;

export type UndoSolo = 'keep' | 'yield';

/** 开着的 solo 条：每条登记“收起自己”的函数和它是哪种 */
const solos = new Map<() => void, UndoSolo>();

export interface UndoToastProps {
  message: string;
  undoLabel: string;
  onUndo(): void;
  /** 收起（到时、或点了撤销之后）；只调一次 */
  onClose(): void;
  ms?: number;
  /** 默认 status；被拦下这类“刚才那一下没生效”的提示用 alert（新挂上的 status 区域 iOS VoiceOver 常常不读，FA-2 审查第 1 条） */
  role?: 'status' | 'alert';
  /** 撤销后面再放一个按钮（电脑版布局的“恢复默认布局”，5.9b）：点了同样收起 */
  more?: { label: string; onClick(): void } | undefined;
  /** 同一时间只留一条（见文件头） */
  solo?: UndoSolo | undefined;
  'data-testid'?: string;
}

export function UndoToast({ message, undoLabel, onUndo, onClose, ms = UNDO_TOAST_MS, role = 'status', more, solo, 'data-testid': testId }: UndoToastProps) {
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

  // solo：挂上时按两种的规矩收起别的条（或让路收起自己），再登记自己
  useEffect(() => {
    if (!solo) return undefined;
    const me = (): void => {
      if (done.current) return;
      done.current = true;
      close.current();
    };
    const others = [...solos];
    if (solo === 'yield' && others.some(([, k]) => k === 'keep')) {
      me();
      return undefined;
    }
    for (const [other, k] of others) if (solo === 'keep' || k === 'yield') other();
    solos.set(me, solo);
    return () => {
      solos.delete(me);
    };
  }, [solo]);

  const act = (fn: () => void) => () => {
    if (done.current) return;
    done.current = true;
    fn();
    close.current();
  };

  return (
    <div
      className={styles.toast}
      data-undo-toast=""
      role={role}
      data-testid={testId}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className={styles.msg}>{message}</span>
      <button type="button" className={styles.undo} onClick={act(onUndo)} data-testid={testId ? `${testId}-undo` : undefined}>
        {undoLabel}
      </button>
      {more ? (
        <button type="button" className={styles.undo} onClick={act(more.onClick)} data-testid={testId ? `${testId}-more` : undefined}>
          {more.label}
        </button>
      ) : null}
    </div>
  );
}
