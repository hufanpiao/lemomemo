// 登录页 /app/auth/（架构 15.6 第 4b 条、5.6、5.9；线框 s14、“加载与出错”、ONB_SAFARI）
// - iPhone、iPad 上不在主屏幕模式运行的（R-225：Safari、Chrome、KakaoTalk、微信等 App 内置浏览器一律算）：
//   只教“添加到主屏幕”，不给登录，也不加载 Turnstile；不是 Safari 时多一句“请在 Safari 里打开本页”
// - 其他（主屏幕版、电脑浏览器）：邮箱 → 6 位验证码；新邮箱多一步邀请码
import { useEffect, useRef, useState } from 'react';
import { installGate, type InstallGate } from '../../../platform/env.ts';
import { clearExitNotice, readExitNotice, type ExitNotice } from '../../../platform/session.ts';
import { useAuthFlow, type AuthFlowDeps } from '../hooks/useAuthFlow.ts';
import { useAuthT } from '../hooks/useAuthT.ts';
import { useSessionGate } from '../hooks/useSessionGate.ts';
import { useTurnstile, type TurnstileAction } from '../hooks/useTurnstile.ts';
import { ErrorCard } from './ErrorCard.tsx';
import { InstallGuide } from './InstallGuide.tsx';
import styles from './AuthPage.module.css';

export interface AuthPageProps {
  /** 测试用：换掉接口、时钟、登录后的跳转 */
  deps?: AuthFlowDeps;
  /** 测试用：不读真的 navigator */
  gate?: InstallGate;
}

export default function AuthPage({ deps, gate }: AuthPageProps) {
  const g = gate ?? installGate();
  return g === 'login' ? <SessionCheck deps={deps} /> : <InstallGuide openInSafari={g === 'install-safari'} />;
}

/**
 * 安全审查 9、架构 0.38 第 35 条：本机已有会话时先说“当前已登录，要换账号请先退出”，
 * “退出并换账号”按 4.1 完整退出（删本会话的 devices 行 → signOut local → 清本机库和缓存）后才出登录表单；“回到 App”回 /app/
 */
function SessionCheck({ deps }: { deps: AuthFlowDeps | undefined }) {
  const t = useAuthT();
  const s = useSessionGate(deps);
  if (s.state === 'none') return <LoginPanel deps={deps} />;
  const busy = s.state === 'exiting';
  return (
    <main className={styles.page} data-feature="auth" data-step="signed-in" aria-busy={busy}>
      <h1 className={styles.title}>{t('auth.title', {})}</h1>
      <p className={styles.lead} data-testid="auth-signed-in">
        {t('auth.session.signedIn', {})}
      </p>
      <div className={styles.form}>
        <button className={styles.primary} type="button" disabled={busy} onClick={() => void s.switchAccount()}>
          {busy ? t('auth.busy', {}) : t('auth.session.switch', {})}
        </button>
        <button className={styles.link} type="button" disabled={busy} onClick={s.backToApp}>
          {t('auth.session.backToApp', {})}
        </button>
      </div>
    </main>
  );
}

const EXIT_KEYS = {
  removed: 'auth.exit.removed',
  disabled: 'auth.exit.disabled',
  pending_deletion: 'auth.exit.pendingDeletion',
} as const satisfies Record<ExitNotice, string>;

/**
 * 退出原因（K6 复审 A）：主 App 被移除、被停用、注销冷静期时清本机后跳到这里，先说一句为什么；显示一次就删，刷新不再出现。
 * 冷静期的恢复要登录以后才能做（服务器回 account_pending_deletion 才出“恢复账号”，0.29 续第 131 条④），这里只给提示
 */
function ExitNoticeLine() {
  const t = useAuthT();
  const [notice] = useState(() => readExitNotice());
  useEffect(() => clearExitNotice(), []);
  if (!notice) return null;
  return (
    <p className={styles.notice} role="alert" data-testid="auth-exit-notice" data-reason={notice}>
      {t(EXIT_KEYS[notice], {})}
    </p>
  );
}

function LoginPanel({ deps }: { deps: AuthFlowDeps | undefined }) {
  const t = useAuthT();
  const box = useRef<HTMLDivElement>(null);
  // 安全审查 10、架构 0.38 第 30 条：登录用 action 'login'；邀请两屏的令牌都只给 start 用（含验证码那屏的重新发送），用 'invite_start'；步骤变了小窗按新的 action 重画
  const [action, setAction] = useState<TurnstileAction>('login');
  const captcha = useTurnstile(box, true, action);
  const flow = useAuthFlow(captcha, deps);
  const { step, email, invite, code, busy, error, hint, cooldown } = flow.state;
  useEffect(() => setAction(step === 'invite' || step === 'invite-code' ? 'invite_start' : 'login'), [step]);
  const askEmail = step === 'email' || step === 'invite';
  const askCode = step === 'code' || step === 'invite-code';

  return (
    <main className={styles.page} data-feature="auth" data-step={step} aria-busy={busy}>
      <h1 className={styles.title}>{t('auth.title', {})}</h1>
      {step === 'email' && <ExitNoticeLine />}
      {step === 'email' && <p className={styles.lead}>{t('auth.lead', {})}</p>}

      {askEmail && (
        <form
          className={styles.form}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void (step === 'invite' ? flow.sendInvite() : flow.sendCode());
          }}
        >
          <label className={styles.label} htmlFor="auth-email">
            {t('auth.email.label', {})}
          </label>
          <input
            id="auth-email"
            className={styles.input}
            type="email"
            name="email"
            autoComplete="email"
            inputMode="email"
            enterKeyHint="go"
            placeholder="name@example.com"
            value={email}
            readOnly={step === 'invite'}
            onChange={(e) => flow.setEmail(e.target.value)}
          />
          {step === 'invite' && (
            <>
              <p className={styles.notice} role="status" data-testid="auth-not-registered">
                {t('auth.invite.notRegistered', {})}
              </p>
              <label className={styles.label} htmlFor="auth-invite">
                {t('auth.invite.label', {})}
              </label>
              <input
                id="auth-invite"
                className={styles.input}
                name="invite"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                enterKeyHint="go"
                value={invite}
                onChange={(e) => flow.setInvite(e.target.value)}
              />
              <p className={styles.sub}>{t('auth.invite.noCode', {})}</p>
            </>
          )}
          <button className={styles.primary} type="submit" disabled={busy || cooldown > 0}>
            {cooldown > 0
              ? t('auth.code.resendIn', { s: cooldown })
              : t(step === 'invite' ? 'auth.invite.next' : 'auth.email.send', {})}
          </button>
          {step === 'invite' && (
            <button className={styles.link} type="button" onClick={flow.backToEmail}>
              {t('auth.code.changeEmail', {})}
            </button>
          )}
        </form>
      )}

      {askCode && (
        <div className={styles.form}>
          <p className={styles.lead}>
            {step === 'invite-code' ? t('auth.invite.sent', {}) : t('auth.code.sentTo', { email: email.trim() })}
          </p>
          {/* 架构 0.38 第 27 条：start 被限流、码不对、发信失败都回 {ok}，界面分不出来，只能提示没收到怎么办 */}
          {step === 'invite-code' && <p className={styles.lead}>{t('auth.invite.noMail', {})}</p>}
          <label className={styles.label} htmlFor="auth-code">
            {t('auth.code.label', {})}
          </label>
          <input
            id="auth-code"
            className={`${styles.input} ${styles.code}`}
            name="code"
            autoComplete="one-time-code"
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={6}
            value={code}
            disabled={busy}
            onChange={(e) => flow.setCode(e.target.value)}
          />
          <div className={styles.row}>
            <button className={styles.link} type="button" disabled={busy || cooldown > 0} onClick={() => void flow.resend()}>
              {cooldown > 0 ? t('auth.code.resendIn', { s: cooldown }) : t('auth.code.resend', {})}
            </button>
            <button className={styles.link} type="button" onClick={flow.backToEmail}>
              {t('auth.code.changeEmail', {})}
            </button>
          </div>
        </div>
      )}

      {hint && (
        <p className={styles.hint} role="alert" data-testid="auth-hint">
          {t(hint === 'email_format' ? 'auth.email.invalid' : hint === 'invite_format' ? 'auth.invite.format' : 'auth.captcha.wait', {})}
        </p>
      )}

      {error && <ErrorCard error={error} onRetry={flow.dismissError} onResend={() => void flow.resend()} />}

      {step === 'done' ? (
        <p className={styles.lead} role="status">
          {t('auth.done', {})}
        </p>
      ) : (
        <section className={styles.captcha} aria-label={t('auth.captcha.label', {})}>
          <div ref={box} data-testid="auth-captcha" />
          {captcha.failed && (
            <p className={styles.hint} role="alert">
              {t('auth.captcha.loadFailed', {})}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
