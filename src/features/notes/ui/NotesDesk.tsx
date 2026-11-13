// 电脑版随手记页（B6；架构 5.9b，R-126 方案 B；定稿线框 s7 电脑画面）：有侧栏的宽度才由 NotesPage 懒加载，手机宽度不下载
// • 两块（块 id 存进布局，改名要写迁移）：cats（标题“随手记” + 竖排分类：全部 N、各分类条数，点了只筛这一页）、
//   list（标题是当前分类“全部 34”；隐私记入口行、合并提示、瀑布流或列表、底部输入行，都是 NotesPage 画好的）
// • 默认两栏：左 0.22 分类、右 0.78 列表（线框 s7）；排法、拖动、收起、保存都在 kit 的 DeskLayout
// • 详情抽屉：DeskLayout 给出抽屉在哪边和换边把手，交给 NotesPage 画 NoteDrawer
import type { CSSProperties, ReactNode } from 'react';
import { LAYOUT_V, type DeskLayoutValue } from '../../../../shared/schema/layout.ts';
import DeskLayout from '../../../kit/components/DeskLayout/DeskLayout.tsx';
import { Pressable } from '../../../motion/components.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import styles from './NotesPage.module.css';

export const NOTES_DEFAULT: DeskLayoutValue = {
  v: LAYOUT_V,
  cols: [
    { w: 0.22, panels: ['cats'] },
    { w: 0.78, panels: ['list'] },
  ],
  collapsed: [],
  drawer: 'right',
  locked: false,
};

export interface DeskCats {
  total: number;
  counts: readonly { id: string; name: string; color: string | null; count: number }[];
  category: string | null;
  set(id: string | null): void;
}

export interface NotesDeskProps {
  cats: DeskCats;
  /** list 块的内容（NotesPage 画好的） */
  list: ReactNode;
  drawer: ((side: 'left' | 'right', handle: ReactNode) => ReactNode) | undefined;
}

export default function NotesDesk({ cats, list, drawer }: NotesDeskProps) {
  const t = useNotesT();
  const cur = cats.counts.find((c) => c.id === cats.category);
  const panels = {
    cats: { title: t('notes.title', {}), body: <CatList cats={cats} /> },
    list: { title: cur ? `${cur.name} ${cur.count}` : t('notes.all', { n: cats.total }), body: list },
  };
  return <DeskLayout page="notes" def={NOTES_DEFAULT} panels={panels} drawer={drawer} />;
}

/** 竖排分类（线框 s7 左栏）：名字在左、条数在右，选中的深底；testid 和手机胶囊一样（e2e 共用） */
function CatList({ cats }: { cats: DeskCats }) {
  const t = useNotesT();
  const item = (id: string | null, name: string, n: number, color: string | null, testId: string) => {
    const on = cats.category === id;
    return (
      <Pressable key={testId} className={on ? styles.catOn : styles.catItem} aria-pressed={on} onClick={() => cats.set(id)} data-testid={testId}>
        {color === null ? null : <i className={styles.dotBig} style={{ '--dot': color } as CSSProperties} aria-hidden="true" />}
        <span className={styles.catLabel}>{name}</span>
        <span className={styles.catN}>{n}</span>
      </Pressable>
    );
  };
  return (
    <div className={styles.cats} role="group" aria-label={t('notes.filter', {})} data-testid="notes-filter">
      {item(null, t('notes.allName', {}), cats.total, null, 'notes-filter-all')}
      {cats.counts.map((c) => item(c.id, c.name, c.count, c.color, `notes-filter-${c.id}`))}
    </div>
  );
}
