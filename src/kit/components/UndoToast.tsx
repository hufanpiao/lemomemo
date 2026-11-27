// 撤销提示条：半透明磨砂，和提示条同一套；44px 点击区
// 用法：删除、批量改动后出一条“已删除 · 撤销”；ms 后自动收起（默认 UNDO_TOAST_MS）；点了撤销或收起都只回调一次
// • role="status"：读屏会读出文字，但不抢焦点（不打断正在做的事）
// • 鼠标悬停、键盘焦点在条上时暂停计时，移开后重新计 ms（读屏用户来得及按到“撤销”）
// • 只渲染，不碰数据：撤销做什么由调用方给 onUndo；不给 onUndo 就没有撤销按钮（没生效、没东西可撤的提示，配 role alert）
// • 根元素带 data-undo-toast：冲突提示卡在撤销条开着时往上让一条
// • solo：带 solo 的条同一时间只留一条（两个撤销条不能叠在一起），被收起的照常回调 onClose、不撤销。分两种：
//   'keep'：删除类撤销条、“＋”的“已记下”、查找面板的改动撤销条，新出来就把别的 solo 条都收起——刚做的那一下能撤销最要紧；
//   'yield'：电脑版布局的“布局已保存”，新出来只收起别的 yield 条；已经有 keep 条开着时让路、自己直接收起（布局还能从“⋯”恢复默认）。
//   冲突提示卡这类本来就和撤销条并存的不带 solo
// • 出现时从下方 12px 升起并淡入（useEnter('lift')，为什么只动 translate 见 motion/presets.ts 的 enters）；收起直接卸载、没有退场
import { useEffect, useRef, useState, type Ref } from 'react';
import { TOAST_MS } from '../../../shared/logic/toast.ts';
import { useEnter } from '../../motion/components.ts';
import float from './Float.module.css';
import styles from './UndoToast.module.css';

/** 提示条默认停多久：唯一一份在 shared/logic/toast.ts（5 秒） */
export const UNDO_TOAST_MS = TOAST_MS;

export type UndoSolo = 'keep' | 'yield';

/** 开着的 solo 条：每条登记“收起自己”的函数和它是哪种 */
const solos = new Map<() => void, UndoSolo>();

export interface UndoToastProps {
  message: string;
  /** 和 onUndo 一起给；都不给就只出文字（如查找面板里改动失败时） */
  undoLabel?: string | undefined;
  onUndo?: (() => void) | undefined;
  /** 收起（到时、或点了撤销之后）；只调一次 */
  onClose(): void;
  ms?: number | undefined;
  /** 默认 status；被拦下这类“刚才那一下没生效”的提示用 alert（新挂上的 status 区域 iOS VoiceOver 常常不读） */
  role?: 'status' | 'alert';
  /** 撤销后面再放一个按钮（电脑版布局的“恢复默认布局”）：点了同样收起 */
  more?: { label: string; onClick(): void } | undefined;
  /** 同一时间只留一条（见文件头） */
  solo?: UndoSolo | undefined;
  /** 挂到“撤销”按钮上（kit useDoneFlow 收完最后一行时把焦点移到这里，不按测试 id 找） */
  undoRef?: Ref<HTMLButtonElement> | undefined;
  'data-testid'?: string;
}

export function UndoToast({ message, undoLabel, onUndo, onClose, ms = UNDO_TOAST_MS, role = 'status', more, solo, undoRef, 'data-testid': testId }: UndoToastProps) {
  const [paused, setPaused] = useState(false);
  const rise = useEnter<HTMLDivElement>('lift');
  /** 第几轮计时：暂停后移开重新计 ms，倒计时色带跟着从满格重来（key 换了就重播动画） */
  const [round, setRound] = useState(0);
  const pause = (on: boolean) => () => {
    setPaused(on);
    if (!on) setRound((r) => r + 1);
  };
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
      ref={rise}
      className={`${float.float} ${styles.toast}`}
      data-undo-toast=""
      role={role}
      data-testid={testId}
      onMouseEnter={pause(true)}
      onMouseLeave={pause(false)}
      onFocus={pause(true)}
      onBlur={pause(false)}
    >
      {/* 倒计时色带：贴底一条柠檬黄，ms 内从满格缩到没有；悬停、焦点在条上时不画，移开后换 key 从满格重新走 */}
      {paused ? null : (
        <span key={round} className={styles.bar} style={{ animationDuration: `${ms}ms` }} aria-hidden="true" data-testid={testId ? `${testId}-bar` : undefined} />
      )}
      <span className={styles.msg}>{message}</span>
      {onUndo && undoLabel ? (
        <button type="button" ref={undoRef} className={styles.undo} onClick={act(onUndo)} data-testid={testId ? `${testId}-undo` : undefined}>
          {undoLabel}
        </button>
      ) : null}
      {more ? (
        <button type="button" className={styles.undo} onClick={act(more.onClick)} data-testid={testId ? `${testId}-more` : undefined}>
          {more.label}
        </button>
      ) : null}
    </div>
  );
}
