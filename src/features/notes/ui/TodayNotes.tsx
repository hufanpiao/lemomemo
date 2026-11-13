// 电脑版今天页“今天记的”块（定稿线框 s1 电脑画面 NOTESTODAY，5.9b 的 notes-today 块）：今天（当前时区）记的随手记，新的在前，最多 5 条
// • 一行：随手记小图标 | 标题 | 时刻 · 分类；点了进这一条的编辑器；没有时写“今天还没记”
// • 经 notes/index.ts 懒加载，只在电脑版今天页下载（手机今天页没有这一块）
import { fmtTime } from '../../../../shared/i18n/fmt.ts';
import { navigate } from '../../../app/router.ts';
import list from '../../../kit/components/List.module.css';
import row from '../../../kit/components/NoteRow.module.css';
import { useNotesT } from '../hooks/useNotesT.ts';
import { useTodayNotes } from '../hooks/useTodayNotes.ts';

const MAX = 5;

export default function TodayNotes() {
  const t = useNotesT();
  const { items, tz } = useTodayNotes(MAX);
  if (items.length === 0) return <p className={list.empty}>{t('notes.todayNone', {})}</p>;
  return (
    <ul className={list.list} data-testid="today-notes">
      {items.map((it) => (
        <li key={it.id} className={list.row}>
          <button type="button" className={list.main} onClick={() => void navigate('note', it.id)}>
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
