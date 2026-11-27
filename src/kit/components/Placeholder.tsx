// 还没做好的页面的占位：只显示功能名，由各功能换成真正的页面（设置入口在今天页右上角头像，这里不放）
// note：功能名下面的一行说明（随手记页的“即将推出”）；套全站同一套空状态样式（List.module.css 的 .empty）
import { useT } from '../hooks/useT.ts';
import list from './List.module.css';
import styles from './Placeholder.module.css';

// title：页面名（随手记页传“随手记 / 메모”）；不传是 App 名。有 note 时说明用正文字体，不像开发占位
export function Placeholder({ feature, note, title }: { feature: string; note?: string; title?: string }) {
  const t = useT();
  return (
    <main className={styles.page} data-feature={feature}>
      <h1 className={styles.title}>{title ?? t('app.name', {})}</h1>
      {note === undefined ? <p className={styles.sub}>{feature}</p> : <p className={list.empty}>{note}</p>}
    </main>
  );
}
