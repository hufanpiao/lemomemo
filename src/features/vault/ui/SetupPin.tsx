// 第一次设密码（线框 s9 FIRSTPW；视觉稿第 1700 行）：输入 → 再输一次；两次一样才调 vault {setup}
// • 下面一行开关“以后用 Face ID 解锁（支持的设备）”：只在这台设备能用时出现；打开时设好密码后马上绑定（绑定要当场的密码，S4）
// • 改密码（设置 › 隐私记）复用同一个两步：先输现在的密码，再输两次新密码
import { useState } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { useAutolockMin, useErrText, useVault } from '../hooks/useVault.ts';
import { useWebauthn } from '../hooks/useVaultAuth.ts';
import { useVaultT, type VaultKey } from '../hooks/useVaultT.ts';
import { LockIcon, PinPad } from './Pin.tsx';
import styles from './Vault.module.css';

/** 两步输新密码：第 1 步输入、第 2 步再输一次；不一样就回第 1 步、提示一句 */
export function NewPinSteps({ title, sub, onDone, busy, error, testId }: {
  title: string; sub: string; onDone(pin: string): void; busy: boolean; error: string; testId: string;
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
      <p className={styles.pinErr} role="status" data-testid={`${testId}-err`}>
        {mismatch ? t('vault.setup.mismatch', {}) : error}
      </p>
      <PinPad
        key={first === null ? 'a' : 'b'}
        disabled={busy}
        testId={`${testId}-pad`}
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
    </div>
  );
}

export function SetupPin({ onCancel, testId = 'vault-setup' }: { onCancel(): void; testId?: string }) {
  const t = useVaultT();
  const { state, s } = useVault();
  const wa = useWebauthn();
  const min = useAutolockMin();
  const [face, setFace] = useState(false);
  const [busy, setBusy] = useState(false);
  const method = t(wa.method === 'faceid' ? 'vault.method.faceid' : 'vault.method.hello', {});
  const done = async (pin: string): Promise<void> => {
    setBusy(true);
    const r = await s.setup(pin);
    if (r.ok && face && wa.usable) await wa.register(pin, method);
    setBusy(false);
  };
  const errText = useErrText();
  const err = state.lastError && state.lastError !== 'vault_locked' ? errText(state.lastError) : '';
  return (
    <>
      <NewPinSteps title={t('vault.setup.title', {})} sub={t('vault.setup.sub', {})} onDone={(p) => void done(p)} busy={busy} error={err} testId={testId} />
      <div className={styles.pin}>
        <div className={styles.pinFoot}>
          {wa.usable ? (
            <label className={styles.toggle}>
              <span>{t('vault.setup.faceid', { method })}</span>
              <input type="checkbox" role="switch" checked={face} onChange={(e) => setFace(e.target.checked)} data-testid={`${testId}-face`} />
            </label>
          ) : null}
          <p className={styles.muted}>{t('vault.autolock', { n: min })}</p>
          <FormButton variant="ghost" onClick={onCancel} data-testid={`${testId}-cancel`}>
            {t('vault.cancel', {})}
          </FormButton>
        </div>
      </div>
    </>
  );
}
