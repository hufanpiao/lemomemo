// iPhone、iPad 上不在主屏幕模式运行时：只教“添加到主屏幕”，不给登录（架构 5.9、TC-B1-17、R-225；线框 ONB_SAFARI）
// 不是 Safari（iOS 的 Chrome、KakaoTalk、微信等）时多一句“请在 Safari 里打开本页再添加到主屏幕”：只有 Safari 能添加到主屏幕
// 另有一句“看不到分享按钮时，先点‘在 Safari 中打开’”：照顾 Gmail 这类 App 里内嵌的 SFSafariViewController（UA 和 Safari 一样，判断不出来）
// 主屏幕版和 Safari 的存储是隔开的：在 Safari 里登录了，主屏幕上的还得再登一次；网页推送也只有主屏幕版能用
import { useAuthT } from '../hooks/useAuthT.ts';
import styles from './AuthPage.module.css';

const STEPS = ['auth.ios.step1', 'auth.ios.step2', 'auth.ios.step3'] as const;

export function InstallGuide({ openInSafari = false }: { openInSafari?: boolean }) {
  const t = useAuthT();
  return (
    <main className={styles.page} data-feature="auth" data-step="install" data-testid="auth-install-guide">
      <h1 className={styles.title}>{t('auth.ios.title', {})}</h1>
      {openInSafari && (
        <p className={styles.notice} role="alert" data-testid="auth-open-in-safari">
          {t('auth.ios.openInSafari', {})}
        </p>
      )}
      <p className={styles.lead}>{t('auth.ios.why', {})}</p>
      <ol className={styles.steps}>
        {STEPS.map((k) => (
          <li key={k} className={styles.step}>
            {t(k, {})}
          </li>
        ))}
      </ol>
      <p className={styles.sub}>{t('auth.ios.noShare', {})}</p>
      <p className={styles.notice}>{t('auth.ios.note', {})}</p>
    </main>
  );
}
