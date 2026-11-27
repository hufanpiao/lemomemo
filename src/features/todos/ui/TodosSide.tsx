// 网页版宽屏待办页右边一列（宽 270）：从上到下三张卡
// • 今天进度：“今天进度 0 / 3”+ 一条进度条（截止日是今天的待办，做完几条 / 共几条）
// • 未来 7 天：“未来 7 天 4 件”+ 七根柱子（今天起七天，每天截止、还没做完的条数；今天那根柠檬黄、星期字加粗）
// • 按项目：每个项目一行“名字 条数”+ 一条比例条（没做完的条数，和页头筛选胶囊同一个数法 projectCounts）
// 只读、只看本机库（kit useCollection），不写；TodosPage 宽屏时才画
import { useMemo } from 'react';
import { addDays, weekdayOf, type DateStr } from '../../../../shared/core/date.ts';
import { isLiveRow } from '../../../../shared/logic/live-row.ts';
import { todoOf } from '../../../../shared/logic/todo-row.ts';
import { DeskCard } from '../../../kit/components/Desk.tsx';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { useListT } from '../hooks/useTodoList.ts';
/** 同 data/todo-list.ts 的 Row（界面层不直接引 data） */
type Row = Readonly<{ id: string } & Record<string, unknown>>;
import styles from './TodosPage.module.css';

const DAYS = 7;

export function TodosSide({ today, projects }: { today: DateStr; projects: readonly { project: string; count: number }[] }) {
  const t = useListT();
  const rows = useCollection<Row>('todos');
  const { done, total, week } = useMemo(() => {
    const live = rows.filter(isLiveRow).map(todoOf);
    const due = live.filter((x) => x.due === today);
    const days = Array.from({ length: DAYS }, (_, i) => addDays(today, i));
    return {
      done: due.filter((x) => x.done).length,
      total: due.length,
      week: days.map((d) => ({ d, n: live.filter((x) => x.due === d && !x.done).length })),
    };
  }, [rows, today]);
  const wd = Array.from(t('list.side.wd', {}));
  const weekN = week.reduce((s, x) => s + x.n, 0);
  const max = Math.max(1, ...week.map((x) => x.n));
  const all = projects.reduce((s, p) => s + p.count, 0);
  return (
    <div className={styles.side}>
      <DeskCard title={t('list.side.progress', {})} end={<span className={styles.num}>{done} / {total}</span>} data-testid="todos-progress">
        <span className={styles.prog} aria-hidden="true">
          <i style={{ width: `${total ? Math.max(4, (done / total) * 100) : 0}%` }} />
        </span>
      </DeskCard>
      <DeskCard title={t('list.side.week', {})} end={t('list.side.weekN', { n: weekN })} data-testid="todos-week">
        <span className={styles.bars} aria-hidden="true">
          {week.map((x, i) => (
            <span key={x.d} data-today={i === 0 ? '' : undefined}>
              <i style={{ height: `${x.n ? Math.max(8, (x.n / max) * 100) : 7}%` }} />
              {wd[weekdayOf(x.d)]}
            </span>
          ))}
        </span>
      </DeskCard>
      {projects.length ? (
        <DeskCard title={t('list.side.projects', {})} data-testid="todos-projects">
          {projects.map((p) => (
            <div key={p.project} className={styles.proj}>
              <span className={styles.projH}>
                <span>{p.project}</span>
                <span className={styles.num}>{p.count}</span>
              </span>
              <span className={styles.prog} aria-hidden="true">
                <i style={{ width: `${all ? (p.count / all) * 100 : 0}%` }} />
              </span>
            </div>
          ))}
        </DeskCard>
      ) : null}
    </div>
  );
}
