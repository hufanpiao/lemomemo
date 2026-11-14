// 解锁（线框 s9 UNLOCKOV / PWERR；视觉稿 PH.unlock）：绑定过 Face ID 时磨砂遮罩 + 解锁卡；输密码是盖满屏幕的整页（同设密码页）
// • 卡片：“隐私记已上锁 / 里面有 N 条 / 用 Face ID 解锁 / 输入密码 / 取消 / 离开 App 1 分钟后自动重新上锁”
//   Face ID 按钮只在这台设备能用（exe、不支持的环境不显示）、绑定过、没有“别处改过密码”（relock）时出现（S4、TC-B5-47 ②）
// • 用不了 Face ID（没绑定、设备不支持、relock）时卡片只有“输入密码”“取消”（线框 s9 说明：“就只显示‘输入密码’”），点了再进密码页
// • 点“输入密码”换成密码键盘；Face ID 连续两次没认出来自动换成密码键盘（D18），标题下写“Face ID 没认出来，请输入密码”
// • 密码页是整页：顶栏“‹ 随手记 … 取消”；输错写“密码不对，还能再试 N 次”、锁定中写倒计时，都在圆点下面、键盘上面（PWERR），键盘不能按
// • “Ctrl + L 立即上锁 · Esc 取消”只在电脑版（侧栏宽度）显示
// • 解锁成功：遮罩淡出 --dur-ui 后卸掉（S21，唯一的动效）；锁上时直接盖上、不做动效
// • 读屏和焦点（审查第 6 条）：遮罩是 Radix Dialog 的模态 Content（同 kit Dialog、smart-search 的 FindPanel；不用 Overlay，CSP 拦它的内联 style），
//   名字是隐藏标题“隐私记已上锁”（aria-labelledby 由 Radix 接），挂上时焦点移到卡里第一个按钮、Tab 圈在遮罩里，遮罩外的内容对读屏隐藏。
//   Esc 由 Radix 接住，经 EscCtx 交给卡片的“取消”（和按钮同一个 cancel）；点遮罩空白处不关
import * as RD from '@radix-ui/react-dialog';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { MQ_SIDEBAR, useMedia } from '../../../kit/hooks/useMedia.ts';
import { useAutolockMin, useErrText, useVault, useVaultCount } from '../hooks/useVault.ts';
import { useWebauthn } from '../hooks/useVaultAuth.ts';
import { useVaultT } from '../hooks/useVaultT.ts';
import { LockIcon, PinPad, PinTop, useDuration } from './Pin.tsx';
import styles from './Vault.module.css';

/** 遮罩把 Esc 交给里面的解锁卡（卡片挂上时登记自己的 cancel） */
const EscCtx = createContext<{ current: (() => void) | null }>({ current: null });

/** 锁定倒计时：每秒刷新一次，到点回 0 */
function useLeft(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  // until 一变先在画出来之前刷新“现在”（原来只在挂上时记，刚锁定那一秒会把卡片开着的时长也算进去：60 秒显示成 1 分 2 秒）
  useLayoutEffect(() => {
    if (until === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [until]);
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}

/**
 * onCancel：取消以后还要做的事（隐私记页回随手记）；可以不给。
 * 有请求等着解锁（waiting）时，取消一律先作废它们（会话的 cancelWait：原请求回失败、卸载时交出的草稿丢掉），三处用法不再各自调（审查第 1 条）
 */
export function UnlockPanel({ onCancel, onForgot, testId = 'vault-unlock', backLabel }: { onCancel?(): void; onForgot(): void; testId?: string; backLabel?: string }) {
  const t = useVaultT();
  const dur = useDuration();
  const errText = useErrText();
  const { state, s } = useVault();
  const wa = useWebauthn();
  const count = useVaultCount();
  const min = useAutolockMin();
  const [mode, setMode] = useState<'card' | 'pin'>('card');
  const [faceFails, setFaceFails] = useState(0);
  const [busy, setBusy] = useState(false);
  const method = wa.label;
  const canFace = wa.canUnlock(state);
  const left = useLeft(state.lockedUntil);
  const locked = left > 0;
  const desk = useMedia(MQ_SIDEBAR);
  const cancel = (): void => {
    if (s.get().waiting) s.cancelWait();
    onCancel?.();
  };
  const esc = useContext(EscCtx);
  useLayoutEffect(() => {
    esc.current = cancel;
  });

  const face = async (): Promise<void> => {
    setBusy(true);
    const r = await wa.unlock();
    setBusy(false);
    if (r?.ok) return;
    const n = faceFails + 1;
    setFaceFails(n);
    if (n >= 2) setMode('pin');
  };
  const pin = async (p: string): Promise<void> => {
    setBusy(true);
    await s.unlock(p);
    setBusy(false);
  };

  const relock = state.relocked ? (
    <p className={styles.notice} role="alert" data-testid={`${testId}-relock`}>
      {t('vault.err.relock', {})}
    </p>
  ) : null;

  // 密码锁定期间照样给 Face ID（服务器锁定期也放行 WebAuthn：生物识别本身就是更强的验证，vault/webauthn.ts 的 unlockWebauthn）；
  // 连续两次没认出照旧换成密码键盘（D18），那时键盘显示倒计时
  if (mode === 'card') {
    return (
      <div className={styles.card} data-testid={`${testId}-card`}>
        {relock}
        <LockIcon big />
        <h2 className={styles.cardTitle}>{t('vault.locked.title', {})}</h2>
        <p className={styles.cardSub}>{faceFails > 0 ? t('vault.unlock.notRecognized', { method }) : t('vault.locked.count', { n: count })}</p>
        <div className={styles.cardBtns}>
          {canFace ? (
            <FormButton variant="primary" block disabled={busy} onClick={() => void face()} data-testid={`${testId}-face`}>
              {t('vault.unlock.with', { method })}
            </FormButton>
          ) : null}
          <FormButton {...(canFace ? {} : { variant: 'primary' as const })} block onClick={() => setMode('pin')} data-testid={`${testId}-pin`}>
            {t('vault.unlock.pin', {})}
          </FormButton>
          <FormButton variant="ghost" block onClick={cancel} data-testid={`${testId}-cancel`}>
            {t('vault.cancel', {})}
          </FormButton>
        </div>
        <p className={styles.cardFoot}>{t('vault.autolock', { n: min })}</p>
      </div>
    );
  }

  const sub = faceFails >= 2 ? t('vault.unlock.notRecognized', { method }) : t('vault.locked.count', { n: count });
  const err = locked
    ? t('vault.unlock.lockedFor', { t: dur(left) })
    : state.lastError === 'pin_wrong' && state.left !== null
      ? t('vault.unlock.left', { n: state.left })
      : state.lastError && state.lastError !== 'vault_locked' && state.lastError !== 'vault_relock'
        ? errText(state.lastError)
        : '';
  // 输密码是整页（线框 s9 PWERR：整页浅灰底、白色圆形数字键），和设密码页（SetupPin 的 NewPinSteps）同一套 .pin 排版和 PinPad；
  // 输错、锁定倒计时写在同一行 .pinErr（04、05）。不再放在白卡片里（卡片底是 --panel，白色圆键在上面看不出是按键）
  return (
    <div className={styles.pinPage} data-testid={`${testId}-pinview`}>
      <PinTop backLabel={backLabel} onCancel={cancel} testId={testId} />
      <div className={styles.pin}>
        {relock}
        <LockIcon big />
        <h2 className={styles.pinTitle}>{t('vault.unlock.enter', {})}</h2>
        <p className={styles.pinSub}>{sub}</p>
        <PinPad onSubmit={(p) => void pin(p)} disabled={busy || locked} testId={`${testId}-pad`} msg={err} msgTestId={`${testId}-err`} />
        <div className={styles.pinFoot}>
          <button type="button" className={styles.link} onClick={onForgot} data-testid={`${testId}-forgot`}>
            {t('vault.unlock.forgot', {})}
          </button>
          {desk ? <p className={styles.muted}>{t('vault.keys', {})}</p> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * 磨砂遮罩里放解锁卡。open 变 false（解锁成功）时淡出 --dur-ui 再卸掉（S21）；open 变 true 时直接出现。
 * 淡出用 transitionend 收尾，另设 400 ms 兜底（减少动态效果、没有 transition 时不会卡住）
 */
export function UnlockOverlay({ open, children, testId = 'vault-scrim' }: { open: boolean; children: ReactNode; testId?: string }) {
  const t = useVaultT();
  const esc = useRef<(() => void) | null>(null);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setShown(true);
      return undefined;
    }
    const id = setTimeout(() => setShown(false), 400);
    return () => clearTimeout(id);
  }, [open]);
  if (!open && !shown) return null;
  const leaving = !open;
  const stay = (e: Event): void => e.preventDefault();
  return (
    <RD.Root open={open} onOpenChange={(o) => (o || !open ? undefined : esc.current?.())}>
      <RD.Content asChild forceMount aria-describedby={undefined} onPointerDownOutside={stay} onFocusOutside={stay} onInteractOutside={stay} onCloseAutoFocus={stay}>
        <div
          className={leaving ? `${styles.scrim} ${styles.scrimOut}` : styles.scrim}
          data-testid={testId}
          data-leaving={leaving || undefined}
          onTransitionEnd={() => leaving && setShown(false)}
          aria-modal="true"
        >
          <RD.Title className={styles.sr}>{t('vault.locked.title', {})}</RD.Title>
          <EscCtx.Provider value={esc}>{children}</EscCtx.Provider>
        </div>
      </RD.Content>
    </RD.Root>
  );
}
