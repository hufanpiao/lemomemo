// 登录页的出错卡片（线框“加载与出错”：每种错误一张，说清楚怎么办，不道歉、不含糊）
import type { AuthErr } from '../hooks/useAuthFlow.ts';
import { useAuthT, type AuthPlainKey } from '../hooks/useAuthT.ts';
import styles from './AuthPage.module.css';

type Card = { title: AuthPlainKey; body: AuthPlainKey; action: 'retry' | 'resend' | null };

const CARDS: Readonly<Record<AuthErr, Card>> = {
  code_wrong: { title: 'auth.err.codeWrong.title', body: 'auth.err.codeWrong.body', action: 'retry' },
  code_invalid: { title: 'auth.err.codeWrong.title', body: 'auth.err.codeWrong.body', action: 'retry' },
  code_expired: { title: 'auth.err.codeExpired.title', body: 'auth.err.codeExpired.body', action: 'resend' },
  send_quota: { title: 'auth.err.sendQuota.title', body: 'auth.err.sendQuota.body', action: null },
  registered_login: { title: 'auth.err.registeredLogin.title', body: 'auth.err.registeredLogin.body', action: null },
  rate_limited: { title: 'auth.err.rateLimited.title', body: 'auth.err.rateLimited.body', action: null },
  invite_invalid: { title: 'auth.err.inviteInvalid.title', body: 'auth.err.inviteInvalid.body', action: 'retry' },
  // 下面三种出现时界面已回到邮箱那一屏（邮箱保留），不用按钮
  email_exists: { title: 'auth.err.emailExists.title', body: 'auth.err.emailExists.body', action: null },
  too_many_tries: { title: 'auth.err.tooManyTries.title', body: 'auth.err.tooManyTries.body', action: null },
  try_later: { title: 'auth.err.tryLater.title', body: 'auth.err.tryLater.body', action: 'retry' },
  verify_limited: { title: 'auth.err.verifyLimited.title', body: 'auth.err.verifyLimited.body', action: null },
  captcha_failed: { title: 'auth.err.captcha.title', body: 'auth.err.captcha.body', action: null },
  offline: { title: 'auth.err.offline.title', body: 'auth.err.offline.body', action: 'retry' },
  unknown: { title: 'auth.err.unknown.title', body: 'auth.err.unknown.body', action: 'retry' },
  // 不会走到这里（界面转成邀请码那一屏），留着让类型完整
  not_registered: { title: 'auth.invite.notRegistered', body: 'auth.invite.noCode', action: null },
};

export function ErrorCard({ error, onRetry, onResend }: { error: AuthErr; onRetry(): void; onResend(): void }) {
  const t = useAuthT();
  const card = CARDS[error];
  return (
    <div className={styles.card} role="alert" data-testid="auth-error" data-error={error}>
      <p className={styles.cardTitle}>{t(card.title, {})}</p>
      <p className={styles.cardBody}>{t(card.body, {})}</p>
      {card.action && (
        <button className={styles.link} type="button" onClick={card.action === 'resend' ? onResend : onRetry}>
          {t(card.action === 'resend' ? 'auth.err.resend' : 'auth.err.retry', {})}
        </button>
      )}
    </div>
  );
}
