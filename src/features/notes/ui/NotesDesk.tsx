// 电脑版随手记页（B6；架构 5.9b，R-126 方案 B；定稿线框 s7 电脑画面）：有侧栏的宽度才由 NotesPage 懒加载，手机宽度不下载
// • 两块（块 id 存进布局，改名要写迁移）：cats（标题“随手记” + 竖排分类：全部 N、各分类条数，点了只筛这一页）、
//   标题字号照线框 s7：“随手记”22px、“全部 34”24px；分类栏底下一行小字“分类由 AI 建立”
//   list（标题是当前分类“全部 34”；隐私记入口行、合并提示、瀑布流或列表、底部输入行，都是 NotesPage 画好的）
// • 默认两栏：左 0.22 分类、右 0.78 列表（线框 s7）；排法、拖动、收起、保存都在 kit 的 DeskLayout
// • 详情抽屉：DeskLayout 给出抽屉在哪边和换边把手，交给 NotesPage 画 NoteDrawer
// • 隐私记页（B5 隐私记重写 11-15）用同一个：page = 'vault'（布局和随手记分开存），title 换成“隐私记”
import type { ReactNode } from 'react';
import { LAYOUT_V, type DeskLayoutValue } from '../../../../shared/schema/layout.ts';
import chip from '../../../kit/components/Chip.module.css';
import DeskLayout from '../../../kit/components/DeskLayout/DeskLayout.tsx';
import { Pressable } from '../../../motion/components.ts';
import { useLongPress } from '../../../motion/gestures.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { useNotesT } from '../hooks/useNotesT.ts';
import { Dot } from './CatDot.tsx';
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
  /** 打开“新分类”（列表页挂的那一份弹窗，useCategoryDialogs） */
  add(): void;
  /** 长按 / 右键某个分类：打开改名、删除 */
  edit(c: { id: string; name: string; color: string | null; count: number }): void;
}

export interface NotesDeskProps {
  /** 布局存进 settings 用的页名（来源的 desk） */
  page: 'notes' | 'vault';
  /** 分类栏标题、读屏 h1；不给就是“随手记” */
  title: string | undefined;
  cats: DeskCats;
  /** 分类栏标题右边的小图标（“最近删除”垃圾桶，R-438 第 2 组丙） */
  titleEnd: ReactNode;
  /** 画读屏用的 h1；来源自己带顶栏（隐私记的 VaultTop 有 h1）时 false，免得两个同名 h1（独立评审 11-19 高 5） */
  srH1: boolean;
  /** list 块的内容（NotesPage 画好的） */
  list: ReactNode;
  drawer: ((side: 'left' | 'right', handle: ReactNode) => ReactNode) | undefined;
}

export default function NotesDesk({ page, title, titleEnd, srH1, cats, list, drawer }: NotesDeskProps) {
  const t = useNotesT();
  const cur = cats.counts.find((c) => c.id === cats.category);
  const name = title ?? t('notes.title', {});
  const panels = {
    cats: { title: name, big: 22 as const, body: <CatList cats={cats} />, end: titleEnd },
    // list 里有输入行（侧栏“＋”要聚焦它）：不能收起
    list: { title: cur ? `${cur.name} ${cur.count}` : t('notes.all', { n: cats.total }), big: 24 as const, body: list, fixed: true },
  };
  return (
    <>
      {/* 页面主标题：电脑版看得见的是“随手记”块标题，读屏仍要一个 h1 */}
      {srH1 ? <h1 className={styles.sr}>{name}</h1> : null}
      <DeskLayout page={page} def={NOTES_DEFAULT} panels={panels} drawer={drawer} />
    </>
  );
}

type DeskCat = DeskCats['counts'][number];

/** 竖排分类的一项（负责人 11-19“其他可以自己编辑分类，可以创建分类”，同手机分类胶囊 CatChips）：点了筛这一类；长按、右键出改名删除；
 *  也是拖进目标（data-drop-into）：列表里没分类的那一条长按拖上来松手，归进这一类 */
function DeskCatItem({ c, on, set, edit }: { c: DeskCat; on: boolean; set(id: string): void; edit(c: DeskCat): void }) {
  const hold = useLongPress(() => {
    rlog('notes cat hold');
    edit(c);
  });
  return (
    <Pressable
      {...hold}
      className={on ? chip.chipOn : `${chip.chip} ${styles.catItem}`}
      aria-pressed={on}
      onClick={() => set(c.id)}
      data-drop-into={c.id}
      data-testid={`notes-filter-${c.id}`}
    >
      <Dot color={c.color} big />
      <span className={styles.catLabel}>{c.name}</span>
      <span className={chip.chipN}>{c.count}</span>
    </Pressable>
  );
}

/** 竖排分类（线框 s7 左栏）：名字在左、条数在右；testid 和手机胶囊一样（e2e 共用）。最后一项“＋ 新分类”。
 *  R-436：外观是 kit 的 Chip.module.css（高 30 的胶囊、条数等宽淡色 .chipN，同待办页筛选；负责人 11-16“胶囊太大了！参考现在的待办页”），
 *  选中的就是 kit .chipOn；没选中的去掉浅底（竖排一列全是灰胶囊太重），悬停再出 */
function CatList({ cats }: { cats: DeskCats }) {
  const t = useNotesT();
  const allOn = cats.category === null;
  return (
    <div className={styles.cats} role="group" aria-label={t('notes.filter', {})} data-testid="notes-filter">
      <Pressable className={allOn ? chip.chipOn : `${chip.chip} ${styles.catItem}`} aria-pressed={allOn} onClick={() => cats.set(null)} data-testid="notes-filter-all">
        <Dot color={null} big />
        <span className={styles.catLabel}>{t('notes.allName', {})}</span>
        <span className={chip.chipN}>{cats.total}</span>
      </Pressable>
      {cats.counts.map((c) => (
        <DeskCatItem key={c.id} c={c} on={cats.category === c.id} set={cats.set} edit={cats.edit} />
      ))}
      <Pressable className={`${chip.chip} ${styles.catItem}`} onClick={cats.add} data-testid="notes-filter-new">
        {t('notes.cat.new', {})}
      </Pressable>
      <p className={styles.aiHint}>{t('notes.aiHint', {})}</p>
    </div>
  );
}
