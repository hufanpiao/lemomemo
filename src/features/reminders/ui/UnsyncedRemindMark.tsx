// 列表行尾“未同步”小标记（TC-B2-69；架构 4.2）：带提醒、还没同步上的记录才标；同步成功后自动消失
import { useUnsyncedRemind } from '../hooks/useUnsynced.ts';
import { useRemindT } from '../hooks/useRemindT.ts';
import styles from './Remind.module.css';

/** 列表行尾的小标记；props: { table: 'events' | 'todos', id } */
export default function UnsyncedRemindMark({ table, id }: { table: 'events' | 'todos'; id: string }) {
  const t = useRemindT();
  const recs = useUnsyncedRemind();
  if (!recs.has(`${table}:${id}`)) return null;
  return (
    <span className={styles.dim} data-testid="remind-unsynced-mark">
      {t('remind.unsynced.mark', {})}
    </span>
  );
}

