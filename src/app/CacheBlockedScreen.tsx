// 升级本机库被别的标签页挡住时的整屏提示。这时 App 还没画，所以不放在顶部横幅里，由 root.tsx 的 watchCacheBlocked 另挂一个根画出来；
// 显示和卸掉都由它管，这里不读 upgrade.blocked。没有按钮：关掉别的窗口以后这一页自己接着打开。样式用整屏提示共用的那一份
import { useT } from '../kit/hooks/useT.ts';
import styles from './CacheTooNewScreen.module.css';

export function CacheBlockedScreen() {
  const t = useT();
  return (
    <div
      className={styles.screen}
      role="alert"
      aria-labelledby="cache-blocked-title"
      aria-describedby="cache-blocked-body"
      data-testid="cache-blocked"
    >
      <div className={styles.card}>
        <h1 id="cache-blocked-title" className={styles.title}>
          {t('update.blocked.title', {})}
        </h1>
        <p id="cache-blocked-body" className={styles.body}>
          {t('update.blocked.body', {})}
        </p>
      </div>
    </div>
  );
}
