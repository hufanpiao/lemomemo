// 密码圆点 + 数字键盘（线框 s9 FIRSTPW / PWERR；视觉稿 .pdots、.kpad）和锁图标
// • 只做 4 位（负责人 11-14 原话“隐私记密只做4位数”，取代线框 s9 的“4 到 12 位、左下角‘确定’”）：固定 4 个圆点，
//   输满 4 位自动交出，没有“确定”键（左下角留空位，键盘还是 3 × 4）
// • 电脑上也能直接按数字键、Backspace（焦点在页面上时）；在锁屏里时键登记在锁屏那一层上（PadLayer，Unlock.tsx 的遮罩给），锁屏下面的页面收不到
// • 输入的数字只在这个组件的 state 里，交出去后立刻清空
// • 手指、鼠标按下（pointerdown）那一刻就记一位，不等 click（负责人 11-15“输入的比较快就识别不到”；运行日志：间隔 0.2 秒的第二下
//   被 iOS 当成双击手势，只有 pointercancel、没有 click）；click 只收键盘激活（detail 为 0：Tab 到键上按空格、回车），不重复记；
//   键盘区 touch-action: manipulation 关掉双击手势
// • 不进运行日志（11-14 隐私记评审第 1 条）：外层带 data-rl-mask，run-log 只记 masked、不记坐标；数字键的 testid 用位置序号 key-0～key-9
//   （按出现顺序：1～9 是 key-0～key-8，0 是 key-9），不带数字本身
// • 提示行（输错、锁定倒计时、两次不一样）在圆点下面、键盘上面（线框 s9 PWERR）
// • VaultTop：隐私记各页的顶栏（一份）；PinTop：设密码、输密码整页的顶栏“‹ 随手记 … 取消”（线框 s9 FIRSTPW、PWERR：“右上角‘取消’随时退出”），也是 VaultTop
// • 忙着（busy）或锁定倒计时时整个键盘不能按，⌫ 也一样
import { createContext, useContext, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { BackLink } from '../../../kit/components/BackLink.tsx';
import { useKeys, type LayerHandle } from '../../../kit/hooks/layers.ts';
import { useVaultT } from '../hooks/useVaultT.ts';
import styles from './Vault.module.css';

/** 键盘在哪一层里（锁屏遮罩给）；不在层里是 null（页面的键） */
export const PadLayer = createContext<LayerHandle | null>(null);

/** 密码位数：和服务器的 PIN_RE（shared/schema/vault.ts）一致 */
export const PIN_LEN = 4;

export function LockIcon({ big = false }: { big?: boolean }) {
  return (
    <svg className={big ? styles.lockicBig : styles.lockic} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M7 10V8a5 5 0 0 1 10 0v2h.5A1.5 1.5 0 0 1 19 11.5v8A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-8A1.5 1.5 0 0 1 6.5 10zm2.4 0h5.2V8a2.6 2.6 0 0 0-5.2 0z" />
    </svg>
  );
}

/**
 * 线框锁（描边 2、圆头，跟文字色；样式 Vault.module.css 的 .lineIc 一份）：
 * • kind="closed"：关着的锁，隐私记记录页返回“‹ 🔒 隐私记”（记录页美化方向 A 方案图的 IC.lock：锁身 14 × 9.5 圆角 2、锁环半径 4），size 14
 * • kind="open"：开着的锁（锁环右边翘起），隐私记列表顶栏下“这里记的只进隐私记”那一行（R-452 V2），size 12
 * 实心锁 LockIcon、解锁页的大锁（LockBadge，锁身填主色）外观不同，另外画
 */
export function LineLock({ kind, size }: { kind: 'closed' | 'open'; size: number }) {
  return (
    <svg className={styles.lineIc} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {kind === 'closed' ? (
        <>
          <rect x="5" y="11" width="14" height="9.5" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 8 0v3" />
        </>
      ) : (
        <>
          <rect x="5" y="11" width="14" height="10" rx="2" />
          <path d="M8 11V8a4 4 0 0 1 7.6-1.7" />
        </>
      )}
    </svg>
  );
}

/** 锁着页（方案甲）的大锁：柠檬黄圆底、描边的锁、锁身填主色（对照图 柠檬记APP-本机资料/设计方案/2026-11-19_隐私记改善/对照_方案vs实现_2026-11-19.png） */
export function LockBadge() {
  return (
    <span className={styles.bigLock}>
      <svg className={styles.bigLockIc} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
        <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      </svg>
    </span>
  );
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'gap', '0', 'del'] as const;
/** 数字键的位置序号（testid 用）：按出现顺序 0～9 */
const DIGIT_SLOT = new Map(KEYS.filter((k) => /^\d$/.test(k)).map((k, i) => [k, i]));

/**
 * 隐私记的顶栏（列表、锁着页、密码整页、最近删除共用一份，原来四处各写一套）：左边返回，中间标题（lock：前面带实心小锁；level：标题级别），右边 end。
 * title、end 不给时那一格放空的 span，三栏照样对齐
 */
export function VaultTop({ back, title = null, lock = false, level = 1, end = null }: {
  back: { label: string; onBack(): void; testId: string };
  title?: ReactNode;
  lock?: boolean;
  level?: 1 | 2;
  end?: ReactNode;
}) {
  const H = level === 1 ? 'h1' : 'h2';
  return (
    <header className={styles.top}>
      <BackLink label={back.label} onBack={back.onBack} testId={back.testId} />
      {title === null ? (
        <span />
      ) : (
        <H className={styles.h1}>
          {lock ? <LockIcon /> : null}
          {title}
        </H>
      )}
      {end ?? <span />}
    </header>
  );
}

/** 设密码、输密码整页的顶栏：左“‹ 随手记”（或调用方给的文字），右“取消”；两个都是退出 */
export function PinTop({ backLabel, onCancel, testId }: { backLabel?: string | undefined; onCancel(): void; testId: string }) {
  const t = useVaultT();
  return (
    <VaultTop
      back={{ label: backLabel ?? t('vault.back', {}), onBack: onCancel, testId: `${testId}-back` }}
      end={
        <button type="button" className={styles.topCancel} onClick={onCancel} data-testid={`${testId}-cancel`}>
          {t('vault.cancel', {})}
        </button>
      }
    />
  );
}

export function PinPad({ onSubmit, disabled = false, testId, msg = '', msgTestId }: {
  onSubmit(pin: string): void; disabled?: boolean; testId: string; msg?: string; msgTestId: string;
}) {
  const t = useVaultT();
  const [pin, setPinState] = useState('');
  // 最新值另记一份：连按（实体键盘快打时监听还没随重画换新）读到的不是旧闭包里的 pin
  const cur = useRef('');
  const setPin = (v: string): void => {
    cur.current = v;
    setPinState(v);
  };
  const press = (k: (typeof KEYS)[number]): void => {
    if (disabled || k === 'gap') return;
    if (k === 'del') return setPin(cur.current.slice(0, -1));
    const next = cur.current + k;
    if (next.length < PIN_LEN) return setPin(next);
    setPin('');
    onSubmit(next);
  };
  // 电脑上的实体键盘：数字、Backspace（kit 层栈的快捷键入口：焦点在输入框里、按着修饰键、上面另有弹层盖着时收不到）
  const hit = (k: (typeof KEYS)[number]) => (): boolean => {
    press(k);
    return true;
  };
  /** 屏幕上的键：按下就记（只认主键）；click 只收键盘激活，指针点出来的 click（detail ≥ 1）已经在按下时记过 */
  const down = (k: (typeof KEYS)[number]) => (e: PointerEvent): void => {
    if (e.button === 0) press(k);
  };
  const kbd = (k: (typeof KEYS)[number]) => (e: MouseEvent): void => {
    if (e.detail === 0) press(k);
  };
  useKeys({ Backspace: hit('del'), ...Object.fromEntries(KEYS.filter((k) => k !== 'gap' && k !== 'del').map((k) => [k, hit(k)])) }, useContext(PadLayer));
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
            <button key={k} type="button" className={`${styles.key} ${styles.keyText}`} aria-label={t('vault.pad.del', {})} onPointerDown={down('del')} onClick={kbd('del')} disabled={disabled} data-testid={`${testId}-del`}>
              ⌫
            </button>
          ) : (
            <button key={k} type="button" className={styles.key} onPointerDown={down(k)} onClick={kbd(k)} disabled={disabled} data-testid={`${testId}-key-${DIGIT_SLOT.get(k) ?? ''}`}>
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
