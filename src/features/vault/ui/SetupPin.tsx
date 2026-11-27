// 第一次设密码：输入 → 再输一次；两次一样才调 vault {setup}
// • 下面一行开关“以后用 Face ID 解锁（支持的设备）”：只在这台设备能用时出现；打开时设好密码后马上绑定（绑定要当场的密码）。
//   密码设好了、绑定没成（系统弹窗取消、服务器拒）：交给页面出提示（onBindFail）——设好密码这一页马上就卸掉了，提示挂在隐私记页上
// • 改密码（设置 › 隐私记）、重设密码复用同一个两步：先输现在的密码，再输两次新密码
// • 键盘下面的提示只看这一次 setup 回的结果（hooks/useVault.ts 的 useFailText），不读会话里共用的 lastError
import { useState, type ReactNode } from 'react';
import { rlog } from '../../../platform/run-log-api.ts';
import { useAutolockMin, useFailText, useVault, type VaultResult } from '../hooks/useVault.ts';
import { useWebauthn } from '../hooks/useVaultAuth.ts';
import { useVaultT, type VaultKey } from '../hooks/useVaultT.ts';
import { LockIcon, PinPad, PinTop } from './Pin.tsx';
import styles from './Vault.module.css';

/** 两步输新密码：第 1 步输入、第 2 步再输一次；不一样就回第 1 步、提示一句。footer：键盘下面另放的一块（设密码页的 Face ID 开关、自动上锁说明） */
export function NewPinSteps({ title, sub, onDone, busy, error, testId, footer = null }: {
  title: string; sub: string; onDone(pin: string): void; busy: boolean; error: string; testId: string; footer?: ReactNode;
}) {
  const t = useVaultT();
  const [first, setFirst] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const step: VaultKey = first === null ? 'vault.setup.step1' : 'vault.setup.step2';
  return (
    <div className={styles.pin} data-testid={testId} data-step={first === null ? 1 : 2}>
      <LockIcon big />
      <h1 className={styles.pinTitle}>{title}</h1>
      <p className={styles.pinSub}>{sub}</p>
      <p className={styles.pinStep}>{t(step, {})}</p>
      <PinPad
        key={first === null ? 'a' : 'b'}
        disabled={busy}
        testId={`${testId}-pad`}
        msg={mismatch ? t('vault.setup.mismatch', {}) : error}
        msgTestId={`${testId}-err`}
        onSubmit={(p) => {
          if (first === null) {
            setFirst(p);
            setMismatch(false);
          } else if (p === first) {
            setFirst(null);
            onDone(p);
          } else {
            setFirst(null);
            setMismatch(true);
          }
        }}
      />
      {footer}
    </div>
  );
}

export function SetupPin({ onCancel, onBindFail, testId = 'vault-setup' }: { onCancel(): void; onBindFail?(method: string): void; testId?: string }) {
  const t = useVaultT();
  const { s } = useVault();
  const wa = useWebauthn();
  const min = useAutolockMin();
  const failText = useFailText();
  const [face, setFace] = useState(false);
  const [busy, setBusy] = useState(false);
  const [fail, setFail] = useState<VaultResult<unknown> | null>(null);
  const method = wa.label;
  const done = async (pin: string): Promise<void> => {
    setBusy(true);
    const r = await s.setup(pin);
    setFail(r);
    if (r.ok && face && wa.usable) {
      const b = await wa.register(pin, method);
      if (!b?.ok) {
        rlog(`vault bind fail ${b ? b.code : 'cancel'}`);
        onBindFail?.(method);
      }
    }
    setBusy(false);
  };
  // 整页盖住底栏，顶栏“‹ 随手记 … 取消”
  return (
    <div className={styles.pinPage} data-testid={`${testId}-page`}>
      <PinTop onCancel={onCancel} testId={testId} />
      <NewPinSteps
        title={t('vault.setup.title', {})}
        sub={t('vault.setup.sub', {})}
        onDone={(p) => void done(p)}
        busy={busy}
        error={failText(fail)}
        testId={testId}
        footer={
          <div className={`${styles.pinFoot} ${styles.pinFootLow}`}>
            {wa.usable ? (
              <label className={styles.toggle}>
                <span>{t('vault.setup.faceid', { method })}</span>
                <input type="checkbox" role="switch" checked={face} onChange={(e) => setFace(e.target.checked)} data-testid={`${testId}-face`} />
              </label>
            ) : null}
            <p className={styles.muted}>{t('vault.autolock', { n: min })}</p>
          </div>
        }
      />
    </div>
  );
}
