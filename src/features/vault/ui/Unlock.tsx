// 解锁卡（线框 s9 UNLOCKOV / PWERR；视觉稿 PH.unlock）：磨砂遮罩 + 卡片
// • 卡片：“隐私记已上锁 / 里面有 N 条 / 用 Face ID 解锁 / 输入密码 / 取消 / 离开 App 1 分钟后自动重新上锁”
//   Face ID 按钮只在这台设备能用（exe、不支持的环境不显示）、绑定过、没有“别处改过密码”（relock）时出现（S4、TC-B5-47 ②）
// • 点“输入密码”换成密码键盘；Face ID 连续两次没认出来自动换成密码键盘（D18），标题下写“Face ID 没认出来，请输入密码”
// • 输错写“密码不对，还能再试 N 次”；锁定中写倒计时，键盘不能按
// • 解锁成功：遮罩淡出 --dur-ui 后卸掉（S21，唯一的动效）；锁上时直接盖上、不做动效
import { useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { useKeys } from '../../../kit/hooks/useKeys.ts';
import { useAutolockMin, useErrText, useVault, useVaultCount } from '../hooks/useVault.ts';
import { useWebauthn } from '../hooks/useVaultAuth.ts';
import { useVaultT } from '../hooks/useVaultT.ts';
import { LockIcon, PinPad, useDuration } from './Pin.tsx';
import styles from './Vault.module.css';

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

export function UnlockPanel({ onCancel, onForgot, testId = 'vault-unlock' }: { onCancel(): void; onForgot(): void; testId?: string }) {
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
  const method = t(wa.method === 'faceid' ? 'vault.method.faceid' : 'vault.method.hello', {});
  const canFace = wa.usable && (state.status?.webauthn ?? 0) > 0 && !state.relocked;
  const left = useLeft(state.lockedUntil);
  const locked = left > 0;
  useKeys({ Escape: () => (onCancel(), true) });

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

  if (mode === 'card' && canFace && !locked) {
    return (
      <div className={styles.card} data-testid={`${testId}-card`}>
        {relock}
        <LockIcon big />
        <h2 className={styles.cardTitle}>{t('vault.locked.title', {})}</h2>
        <p className={styles.cardSub}>{faceFails > 0 ? t('vault.unlock.notRecognized', { method }) : t('vault.locked.count', { n: count })}</p>
        <div className={styles.cardBtns}>
          <FormButton variant="primary" block disabled={busy} onClick={() => void face()} data-testid={`${testId}-face`}>
            {t('vault.unlock.with', { method })}
          </FormButton>
          <FormButton block onClick={() => setMode('pin')} data-testid={`${testId}-pin`}>
            {t('vault.unlock.pin', {})}
          </FormButton>
          <FormButton variant="ghost" block onClick={onCancel} data-testid={`${testId}-cancel`}>
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
  return (
    <div className={`${styles.card} ${styles.pin}`} data-testid={`${testId}-pinview`}>
      {relock}
      <LockIcon big />
      <h2 className={styles.cardTitle}>{t('vault.unlock.enter', {})}</h2>
      <p className={styles.cardSub}>{sub}</p>
      <p className={styles.pinErr} role="status" data-testid={`${testId}-err`}>
        {err}
      </p>
      <PinPad onSubmit={(p) => void pin(p)} disabled={busy || locked} testId={`${testId}-pad`} />
      <div className={styles.pinFoot}>
        <button type="button" className={styles.link} onClick={onForgot} data-testid={`${testId}-forgot`}>
          {t('vault.unlock.forgot', {})}
        </button>
        <FormButton variant="ghost" onClick={onCancel} data-testid={`${testId}-cancel`}>
          {t('vault.cancel', {})}
        </FormButton>
        <p className={styles.muted}>{t('vault.keys', {})}</p>
      </div>
    </div>
  );
}

/**
 * 磨砂遮罩里放解锁卡。open 变 false（解锁成功）时淡出 --dur-ui 再卸掉（S21）；open 变 true 时直接出现。
 * 淡出用 transitionend 收尾，另设 400 ms 兜底（减少动态效果、没有 transition 时不会卡住）
 */
export function UnlockOverlay({ open, children, testId = 'vault-scrim' }: { open: boolean; children: ReactNode; testId?: string }) {
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
  return (
    <div
      className={leaving ? `${styles.scrim} ${styles.scrimOut}` : styles.scrim}
      data-testid={testId}
      data-leaving={leaving || undefined}
      onTransitionEnd={() => leaving && setShown(false)}
      role="dialog"
      aria-modal="true"
    >
      {children}
    </div>
  );
}
