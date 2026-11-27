// exe 登录小窗口：登录好了但 auth_done 没调成（Rust 没关小窗口、main 没收到）时，提示一句并给“重试”。
// 平时什么都不画；网页版不会出现（网页版直接跳 /app/，不调 auth_done）
import { useState, useSyncExternalStore } from 'react';
import { authDoneFailed, retryAuthDone, subscribeAuthDone } from '../../../platform/desktop-auth.ts';
import { useAuthT } from '../hooks/useAuthT.ts';
import styles from './AuthPage.module.css';

export function AuthDoneRetry({ retry = () => retryAuthDone() }: { retry?: () => Promise<boolean> }) {
  const t = useAuthT();
  const failed = useSyncExternalStore(subscribeAuthDone, authDoneFailed, authDoneFailed);
  const [busy, setBusy] = useState(false);
  if (!failed) return null;
  return (
    <div className={styles.notice} role="alert" data-testid="auth-done-failed">
      <p>{t('auth.exe.doneFailed', {})}</p>
      <button
        className={styles.primary}
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void retry().finally(() => setBusy(false));
        }}
      >
        {t('auth.exe.doneRetry', {})}
      </button>
    </div>
  );
}
