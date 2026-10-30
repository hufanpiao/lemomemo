// B0 骨架阶段各页面的占位：只显示功能名，B1 起由各功能换成真正的页面
// 设置入口（接手清单 PLACEHOLDER-settings-link；负责人 10-30 在 iPhone 主屏幕版发现）：主屏幕版没有地址栏，
// 注册后进到 today 只有占位页，设置页、注销页都进不去。B2 真页面出来以前先放一个链接，B2 换真页面时一并去掉
import { hrefOf } from '../../app/router.ts';
import { useT } from '../hooks/useT.ts';
import styles from './Placeholder.module.css';

export function Placeholder({ feature }: { feature: string }) {
  const t = useT();
  return (
    <main className={styles.page} data-feature={feature}>
      <h1 className={styles.title}>{t('app.name', {})}</h1>
      <p className={styles.sub}>{feature}</p>
      <a className={styles.settings} href={hrefOf('settings')}>
        {t('app.settings', {})}
        <span aria-hidden="true"> ›</span>
      </a>
    </main>
  );
}
