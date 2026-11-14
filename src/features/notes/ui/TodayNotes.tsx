// 电脑版今天页“今天记的”块（定稿线框 s1 电脑画面 NOTESTODAY，5.9b 的 notes-today 块）：今天（当前时区）记的随手记，新的在前，最多 5 条
// • 一行：随手记小图标 | 标题 | 时刻 · 分类；点了在今天页的详情抽屉里打开这一条（线框 s1“选中一条：详情抽屉从右边盖上来”，B6 对齐线框）；没有时写“今天还没记”
// • 经 notes/index.ts 懒加载，只在电脑版今天页下载（手机今天页没有这一块）
// • onCount：今天一共几条，交给今天页写进块标题“今天记的 2”（线框 NOTESTODAY；标题在 kit DeskLayout 里画，不在这个块里）
// • 同一个懒加载入口按 part 画三样（同 today 的 TodayToasts）：'list' 是这一块，'drawer' 是随手记页同一个 NoteDrawer（外壳和编辑器，再按需下载；
//   挂起时落到今天页那一层 Suspense）；B4b-3 加 'thumb'：查找面板“最相关”里一张插图的缩略图（ui/note-thumb.tsx，再按需下载）；
//   不在 notes/index.ts 另开一个入口，那个文件在主包里，多一个 lazy 首屏就多几十字节（首屏净增额度，build/first-screen-baseline.json）
// • 选中哪一条由今天页管（kit useListActions.ts 的 useDrawerSel）；行按钮带 data-open，抽屉关上时焦点找回这一行
import { lazy, Suspense, useEffect } from 'react';
import { fmtTime } from '../../../../shared/i18n/fmt.ts';
import list from '../../../kit/components/List.module.css';
import row from '../../../kit/components/NoteRow.module.css';
import { useNotesT } from '../hooks/useNotesT.ts';
import { useTodayNotes } from '../hooks/useTodayNotes.ts';
import type { NoteDrawerProps } from './NoteDrawer.tsx';

const MAX = 5;

const NoteDrawer = lazy(() => import('./NoteDrawer.tsx').then((m) => ({ default: m.NoteDrawer })));
const NoteThumb = lazy(() => import('./note-thumb.tsx'));

export type TodayNotesProps =
  | { part: 'list'; onCount?(n: number): void; onOpen(id: string): void; selected: string | null }
  | ({ part: 'drawer' } & NoteDrawerProps)
  | { part: 'thumb'; noteId: string; imageId: string };

export default function TodayNotes(p: TodayNotesProps) {
  if (p.part === 'thumb') {
    return (
      <Suspense fallback={null}>
        <NoteThumb noteId={p.noteId} imageId={p.imageId} />
      </Suspense>
    );
  }
  return p.part === 'drawer' ? <NoteDrawer id={p.id} onClose={p.onClose} side={p.side} handle={p.handle} /> : <NotesToday {...p} />;
}

function NotesToday({ onCount, onOpen, selected }: Extract<TodayNotesProps, { part: 'list' }>) {
  const t = useNotesT();
  const { items, count, tz } = useTodayNotes(MAX);
  useEffect(() => onCount?.(count), [onCount, count]);
  if (items.length === 0) return <p className={list.empty}>{t('notes.todayNone', {})}</p>;
  return (
    <ul className={list.list} data-testid="today-notes">
      {items.map((it) => (
        <li key={it.id} className={list.row}>
          <button type="button" className={list.main} onClick={() => onOpen(it.id)} data-open={it.id} aria-current={selected === it.id ? 'true' : undefined}>
            <span className={row.mn} aria-hidden="true" />
            <span className={list.text}>
              <span className={list.title}>{it.title}</span>
              <span className={list.meta}>{[fmtTime(it.createdAt, tz), it.categoryName ?? ''].filter(Boolean).join(' · ')}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
