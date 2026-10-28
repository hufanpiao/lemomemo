// B0 骨架阶段各页面的占位：只显示功能名，B1 起由各功能换成真正的页面
import { useT } from '../hooks/useT.ts';
import styles from './Placeholder.module.css';

export function Placeholder({ feature }: { feature: string }) {
  const t = useT();
  return (
    <main className={styles.page} data-feature={feature}>
      <h1 className={styles.title}>{t('app.name', {})}</h1>
      <p className={styles.sub}>{feature}</p>
    </main>
  );
}
