// 密码圆点 + 数字键盘（线框 s9 FIRSTPW / PWERR；视觉稿 .pdots、.kpad）和锁图标
// • 圆点随输入增加，后面只多画一个空位，不暗示上限；“确定”在左下角，输够 4 位才能按；输到 12 位后不再接收（线框 s9 说明）
// • 电脑上也能直接按数字键、Backspace、Enter（焦点在页面上时）
// • 输入的数字只在这个组件的 state 里，交出去后立刻清空
// • 不进运行日志（11-14 隐私记评审第 1 条）：外层带 data-rl-mask，run-log 只记 masked、不记坐标；数字键的 testid 用位置序号 key-0～key-9
//   （按出现顺序：1～9 是 key-0～key-8，0 是 key-9），不带数字本身
import { useEffect, useState } from 'react';
import { useVaultT } from '../hooks/useVaultT.ts';
import styles from './Vault.module.css';

export const PIN_MIN = 4;
export const PIN_MAX = 12;

export function LockIcon({ big = false }: { big?: boolean }) {
  return (
    <svg className={big ? styles.lockicBig : styles.lockic} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M7 10V8a5 5 0 0 1 10 0v2h.5A1.5 1.5 0 0 1 19 11.5v8A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-8A1.5 1.5 0 0 1 6.5 10zm2.4 0h5.2V8a2.6 2.6 0 0 0-5.2 0z" />
    </svg>
  );
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'ok', '0', 'del'] as const;
/** 数字键的位置序号（testid 用）：按出现顺序 0～9 */
const DIGIT_SLOT = new Map(KEYS.filter((k) => /^\d$/.test(k)).map((k, i) => [k, i]));

export function PinPad({ onSubmit, disabled = false, testId }: { onSubmit(pin: string): void; disabled?: boolean; testId: string }) {
  const t = useVaultT();
  const [pin, setPin] = useState('');
  const ready = pin.length >= PIN_MIN && !disabled;
  const submit = (): void => {
    if (!ready) return;
    const p = pin;
    setPin('');
    onSubmit(p);
  };
  const press = (k: (typeof KEYS)[number]): void => {
    if (disabled) return;
    if (k === 'ok') submit();
    else if (k === 'del') setPin((p) => p.slice(0, -1));
    else setPin((p) => (p.length >= PIN_MAX ? p : p + k));
  };
  // 电脑上的实体键盘：数字、Backspace、Enter
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (/^\d$/.test(e.key)) press(e.key as (typeof KEYS)[number]);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Enter') press('ok');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });
  const shown = Math.max(pin.length + 1, PIN_MIN);
  return (
    <div data-testid={testId} data-rl-mask="">
      <div className={styles.dots} role="img" aria-label={t('vault.pad.filled', { n: pin.length })} data-testid={`${testId}-dots`} data-n={pin.length}>
        {Array.from({ length: Math.min(shown, PIN_MAX) }, (_, i) => (
          <i key={i} className={`${styles.dot}${i < pin.length ? ` ${styles.dotOn}` : i >= PIN_MIN ? ` ${styles.dotMore}` : ''}`} />
        ))}
      </div>
      <div className={styles.pad}>
        {KEYS.map((k) =>
          k === 'ok' ? (
            <button key={k} type="button" className={`${styles.key} ${styles.keyText}`} aria-disabled={!ready || undefined} onClick={submit} data-testid={`${testId}-ok`}>
              {t('vault.pad.ok', {})}
            </button>
          ) : k === 'del' ? (
            <button key={k} type="button" className={`${styles.key} ${styles.keyText}`} aria-label={t('vault.pad.del', {})} onClick={() => press('del')} data-testid={`${testId}-del`}>
              ⌫
            </button>
          ) : (
            <button key={k} type="button" className={styles.key} onClick={() => press(k)} disabled={disabled} data-testid={`${testId}-key-${DIGIT_SLOT.get(k) ?? ''}`}>
              {k}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/** 秒数 → “45 秒 / 4 分 59 秒 / 3 小时 59 分” */
export function useDuration() {
  const t = useVaultT();
  return (sec: number): string => {
    const s = Math.max(0, Math.ceil(sec));
    if (s < 60) return t('vault.time.s', { n: s });
    if (s < 3600) return t('vault.time.m', { m: Math.floor(s / 60), s: s % 60 });
    return t('vault.time.h', { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
  };
}
