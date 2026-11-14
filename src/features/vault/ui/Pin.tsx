// 密码圆点 + 数字键盘（线框 s9 FIRSTPW / PWERR；视觉稿 .pdots、.kpad）和锁图标
// • 只做 4 位（负责人 11-14 原话“隐私记密只做4位数”，取代线框 s9 的“4 到 12 位、左下角‘确定’”）：固定 4 个圆点，
//   输满 4 位自动交出，没有“确定”键（左下角留空位，键盘还是 3 × 4）
// • 电脑上也能直接按数字键、Backspace（焦点在页面上时）
// • 输入的数字只在这个组件的 state 里，交出去后立刻清空
// • 不进运行日志（11-14 隐私记评审第 1 条）：外层带 data-rl-mask，run-log 只记 masked、不记坐标；数字键的 testid 用位置序号 key-0～key-9
//   （按出现顺序：1～9 是 key-0～key-8，0 是 key-9），不带数字本身
// • 提示行（输错、锁定倒计时、两次不一样）在圆点下面、键盘上面（线框 s9 PWERR）
// • PinTop：设密码、输密码整页的顶栏“‹ 随手记 … 取消”（线框 s9 FIRSTPW、PWERR：“右上角‘取消’随时退出”）
import { useEffect, useState } from 'react';
import { BackLink } from '../../../kit/components/BackLink.tsx';
import { useVaultT } from '../hooks/useVaultT.ts';
import styles from './Vault.module.css';

/** 密码位数：和服务器的 PIN_RE（shared/schema/vault.ts）一致 */
export const PIN_LEN = 4;

export function LockIcon({ big = false }: { big?: boolean }) {
  return (
    <svg className={big ? styles.lockicBig : styles.lockic} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M7 10V8a5 5 0 0 1 10 0v2h.5A1.5 1.5 0 0 1 19 11.5v8A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-8A1.5 1.5 0 0 1 6.5 10zm2.4 0h5.2V8a2.6 2.6 0 0 0-5.2 0z" />
    </svg>
  );
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'gap', '0', 'del'] as const;
/** 数字键的位置序号（testid 用）：按出现顺序 0～9 */
const DIGIT_SLOT = new Map(KEYS.filter((k) => /^\d$/.test(k)).map((k, i) => [k, i]));

/** 整页顶栏：左“‹ 随手记”（或调用方给的文字），右“取消”；两个都是退出 */
export function PinTop({ backLabel, onCancel, testId }: { backLabel?: string | undefined; onCancel(): void; testId: string }) {
  const t = useVaultT();
  return (
    <header className={styles.top}>
      <BackLink label={backLabel ?? t('vault.back', {})} onBack={onCancel} testId={`${testId}-back`} />
      <span />
      <button type="button" className={styles.topCancel} onClick={onCancel} data-testid={`${testId}-cancel`}>
        {t('vault.cancel', {})}
      </button>
    </header>
  );
}

export function PinPad({ onSubmit, disabled = false, testId, msg = '', msgTestId }: {
  onSubmit(pin: string): void; disabled?: boolean; testId: string; msg?: string; msgTestId: string;
}) {
  const t = useVaultT();
  const [pin, setPin] = useState('');
  const press = (k: (typeof KEYS)[number]): void => {
    if (disabled || k === 'gap') return;
    if (k === 'del') return setPin((p) => p.slice(0, -1));
    const next = pin + k;
    if (next.length < PIN_LEN) return setPin(next);
    setPin('');
    onSubmit(next);
  };
  // 电脑上的实体键盘：数字、Backspace、Enter
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (/^\d$/.test(e.key)) press(e.key as (typeof KEYS)[number]);
      else if (e.key === 'Backspace') press('del');
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });
  return (
    <div data-testid={testId} data-rl-mask="">
      <div className={styles.dots} role="img" aria-label={t('vault.pad.filled', { n: pin.length })} data-testid={`${testId}-dots`} data-n={pin.length}>
        {Array.from({ length: PIN_LEN }, (_, i) => (
          <i key={i} className={i < pin.length ? `${styles.dot} ${styles.dotOn}` : styles.dot} />
        ))}
      </div>
      <p className={styles.pinErr} role="status" data-testid={msgTestId}>
        {msg}
      </p>
      <div className={styles.pad}>
        {KEYS.map((k) =>
          k === 'gap' ? (
            <span key={k} aria-hidden="true" />
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
