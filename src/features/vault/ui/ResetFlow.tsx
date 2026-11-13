// 忘记密码：用登录邮箱重设（B5 S3）：说明 → 发验证码 → 填 6 位验证码（交接设备行）→ 设新密码两次 → 完成
// • 交接失败：新会话已丢掉、继续用原来的会话，提示“没有验证成功，请重试”（TC-B1-86）；
//   rate_limited → “今天重新验证的次数太多，请明天再试”；验证码不对 → “验证码不对或已过期”
import { useState } from 'react';
import { FormButton } from '../../../kit/components/Form.tsx';
import { useVaultReset } from '../hooks/useVaultAuth.ts';
import { useVaultT, type VaultKey } from '../hooks/useVaultT.ts';
import { NewPinSteps } from './SetupPin.tsx';
import styles from './Vault.module.css';

const ERR = {
  rate_limited: 'vault.reset.rate',
  otp_invalid: 'vault.reset.otp',
  offline: 'vault.err.offline',
  try_later: 'vault.err.tryLater',
  reauth_required: 'vault.err.reauth',
  session_revoked: 'vault.err.revoked',
  signed_out: 'vault.err.revoked',
} as const satisfies Record<string, VaultKey>;
const errKey = (e: string): (typeof ERR)[keyof typeof ERR] | 'vault.reset.fail' => (Object.hasOwn(ERR, e) ? ERR[e as keyof typeof ERR] : 'vault.reset.fail');

export function ResetFlow({ onDone }: { onDone(): void }) {
  const t = useVaultT();
  const r = useVaultReset();
  const [code, setCode] = useState('');
  const err = r.error ? t(errKey(r.error), {}) : '';

  if (!r.email)
    return (
      <p className={styles.notice} role="alert" data-testid="vault-reset-noemail">
        {t('vault.reset.noEmail', {})}
      </p>
    );
  if (r.step === 'pin') return <NewPinSteps title={t('vault.reset.new', {})} sub="" busy={r.busy} error={err} testId="vault-reset-pin" onDone={(p) => void r.setPin(p)} />;
  if (r.step === 'done')
    return (
      <div className={styles.flow} data-testid="vault-reset-done">
        <p className={styles.notice} role="status">
          {t('vault.reset.done', {})}
        </p>
        <FormButton onClick={onDone}>{t('vault.ok', {})}</FormButton>
      </div>
    );
  return (
    <div className={styles.flow} data-testid={`vault-reset-${r.step}`}>
      <h2 className={styles.pinTitle}>{t('vault.reset.title', {})}</h2>
      <p className={styles.pinSub}>{t('vault.reset.body', { email: r.email })}</p>
      {r.step === 'code' ? (
        <>
          <input
            className={styles.codeInput}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            aria-label={t('vault.reset.code', {})}
            placeholder="000000"
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            data-testid="vault-reset-code"
          />
          <FormButton variant="primary" disabled={r.busy || code.length !== 6} onClick={() => void r.verify(code)} data-testid="vault-reset-verify">
            {r.busy ? t('vault.reset.verifying', {}) : t('vault.reset.verify', {})}
          </FormButton>
        </>
      ) : (
        <FormButton variant="primary" disabled={r.busy} onClick={() => void r.send()} data-testid="vault-reset-send">
          {r.busy ? t('vault.reset.sending', {}) : t('vault.reset.send', {})}
        </FormButton>
      )}
      <p className={styles.pinErr} role="status" data-testid="vault-reset-err">
        {err}
      </p>
      <FormButton variant="ghost" onClick={onDone} data-testid="vault-reset-cancel">
        {t('vault.cancel', {})}
      </FormButton>
    </div>
  );
}
