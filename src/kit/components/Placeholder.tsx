// B0 骨架阶段各页面的占位：只显示功能名，各批次由各功能换成真正的页面
// 原来的临时设置链接（PLACEHOLDER-settings-link）随底栏上线去掉（B2 FA-7；设置入口在今天页右上角头像，负责人 11-05 ①）
// note：功能名下面的一行说明（随手记页的“即将推出”，负责人 11-05 ②）
import { useT } from '../hooks/useT.ts';
import styles from './Placeholder.module.css';

// title：页面名（随手记页传“随手记 / 메모”，设计动效评审 L5）；不传是 App 名。有 note 时说明用正文字体，不像开发占位
export function Placeholder({ feature, note, title }: { feature: string; note?: string; title?: string }) {
  const t = useT();
  return (
    <main className={styles.page} data-feature={feature}>
      <h1 className={styles.title}>{title ?? t('app.name', {})}</h1>
      {note === undefined ? <p className={styles.sub}>{feature}</p> : <p className={styles.note}>{note}</p>}
    </main>
  );
}
