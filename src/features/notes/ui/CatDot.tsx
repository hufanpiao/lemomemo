// 分类色点（随手记列表、电脑版分类栏共用，B6 从 NotesPage.tsx 挪出；放在单独的小文件里，电脑版分包不用带上整个列表页）
import type { CSSProperties } from 'react';
import styles from './NotesPage.module.css';

/** 只在有颜色时画；big 是分类栏、合并提示里的大点 */
export const Dot = ({ color, big }: { color: string | null; big?: boolean }) =>
  color === null ? null : <i className={big ? styles.dotBig : styles.dot} style={{ '--dot': color } as CSSProperties} aria-hidden="true" />;
