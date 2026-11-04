// 离线新建的提醒（B2 FA-4；架构 4.2“离线新建的提醒”、1.2 风险表“离线提醒”；TC-B2-69）
// • 带提醒、还没同步上的记录（outbox 状态的 remindRecs，`${table}:${id}`）：列表行尾标“未同步”小标记（UnsyncedRemindMark），
//   页面上出一行“未同步，提醒可能不响”（UnsyncedRemindHint）；不带提醒的不标、不出
// • 同步成功（服务器回执）后 outbox 把它移出 remindRecs，标记和提示自动消失
// 小标记在 UnsyncedRemindMark.tsx；两个都由列表、今天页经 reminders 的 index.ts 懒加载挂（见交付说明的接线清单）
import { useUnsyncedRemind } from '../hooks/useUnsynced.ts';
import { useRemindT } from '../hooks/useRemindT.ts';
import styles from './Remind.module.css';

/** 页面上一行提示；有带提醒、没同步上的记录才出 */
export default function UnsyncedRemindHint() {
  const t = useRemindT();
  const recs = useUnsyncedRemind();
  if (recs.size === 0) return null;
  return (
    <p className={styles.dim} role="status" data-testid="remind-unsynced-hint">
      {t('remind.unsynced', {})}
    </p>
  );
}
