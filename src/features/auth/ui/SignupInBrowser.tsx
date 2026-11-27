// exe 登录小窗口里“这个邮箱还没注册”时的出口（exe 里不做注册，走系统浏览器）：一个按钮，打不开时提示一句
import { useState } from 'react';
import { useAuthT } from '../hooks/useAuthT.ts';
import styles from './AuthPage.module.css';

export function SignupInBrowser({ open }: { open: () => Promise<boolean> }) {
  const t = useAuthT();
  const [failed, setFailed] = useState(false);
  return (
    <>
      <button
        className={styles.primary}
        type="button"
        onClick={() => {
          setFailed(false);
          void open().then((ok) => setFailed(!ok));
        }}
      >
        {t('auth.invite.openSignup', {})}
      </button>
      {failed && (
        <p className={styles.hint} role="alert" data-testid="auth-signup-failed">
          {t('auth.invite.openSignupFailed', {})}
        </p>
      )}
    </>
  );
}
