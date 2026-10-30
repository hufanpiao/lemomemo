// 升级本机库被别的标签页挡住（blocked，TC-B1-48；架构 4.1“仍被挡住时提示请关掉其他打开的柠檬记窗口”，架构师 10-30 第 8 点）：
// 整屏提示（文案见 update.blocked.title）。这时 coldStart 还在等库打开、App 还没画，所以不放在顶部横幅里，
// 由 root.tsx 的 watchCacheBlocked 另挂一个根画出来；别的窗口关掉、库打开以后（upgrade.blocked 变回 false）自动消失。
// 显示和卸掉都由 watchCacheBlocked 管（BANNER-sugg ①：blocked 解除后要等 App 画出来再卸），这里不再读 upgrade.blocked。
// 没有按钮：关掉别的窗口以后这一页自己接着打开，不用用户再点。读屏：role="alert"，标题、说明分别接 aria-labelledby / aria-describedby
import { useT } from '../kit/hooks/useT.ts';
import styles from './CacheBlockedScreen.module.css';

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
