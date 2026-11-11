// 登录页的“登录已过期”（R-382 架构 4.1a 第 2 点）：有 lemo.reauth 时，填邮箱那一步上面先说为什么、内容还在；下面给“清除这台设备上的内容”
// • ReauthNotice（输入框上方）：expired → “登录已过期，请重新登录” + 小字“这台设备上的内容都还在……不是你的设备，请点清除”；
//   本机 outbox 还有没发的 → “这台设备上还有 N 条另一个账号没同步的修改，换账号登录会丢掉”（只说条数，不显示原账号的邮箱）；
//   再查回 revoked 已清库 → 原来那句“被移除……还没上传的改动已丢弃”；点了清除 → “已清除”
// • ReauthClear（表单下方）：先问一次再清（清了没同步的修改就没了），清完上面换成“已清除”
import { useState } from 'react';
import type { ReauthView } from '../hooks/useReauth.ts';
import { useAuthT } from '../hooks/useAuthT.ts';
import styles from './AuthPage.module.css';

export function ReauthNotice({ view }: { view: ReauthView }) {
  const t = useAuthT();
  if (view.kind === 'removed') {
    return (
      <p className={styles.notice} role="alert" data-testid="auth-exit-notice" data-reason="removed">
        {t('auth.exit.removed', {})}
      </p>
    );
  }
  if (view.kind === 'cleared') {
    return (
      <p className={styles.notice} role="status" data-testid="auth-reauth-cleared">
        {t('auth.reauth.cleared', {})}
      </p>
    );
  }
  if (view.kind !== 'expired') return null;
  return (
    <>
      <p className={styles.notice} role="alert" data-testid="auth-exit-notice" data-reason={view.reason}>
        {t(view.reason === 'disabled' ? 'auth.exit.disabled' : 'auth.exit.expired', {})}
      </p>
      <p className={styles.sub} data-testid="auth-reauth-kept">
        {t('auth.reauth.kept', {})}
      </p>
      {view.pending !== null && view.pending > 0 && (
        <p className={styles.notice} role="status" data-testid="auth-reauth-pending">
          {t('auth.reauth.pending', { n: view.pending })}
        </p>
      )}
    </>
  );
}

export function ReauthClear({ view, onClear }: { view: ReauthView; onClear: () => void }) {
  const t = useAuthT();
  const [asking, setAsking] = useState(false);
  if (view.kind !== 'expired') return null;
  if (!asking) {
    return (
      <div className={styles.form}>
        <button className={styles.link} type="button" disabled={view.busy} data-testid="auth-reauth-clear" onClick={() => setAsking(true)}>
          {t('auth.reauth.clear', {})}
        </button>
      </div>
    );
  }
  return (
    <div className={styles.form} data-testid="auth-reauth-confirm">
      <p className={styles.sub}>{t('auth.reauth.clearConfirm', {})}</p>
      <div className={styles.row}>
        <button className={styles.link} type="button" disabled={view.busy} data-testid="auth-reauth-clear-yes" onClick={onClear}>
          {t('auth.reauth.clearYes', {})}
        </button>
        <button className={styles.link} type="button" disabled={view.busy} onClick={() => setAsking(false)}>
          {t('auth.reauth.clearNo', {})}
        </button>
      </div>
    </div>
  );
}
