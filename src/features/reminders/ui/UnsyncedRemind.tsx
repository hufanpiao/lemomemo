// 离线新建的提醒（B2 FA-4；架构 4.2“离线新建的提醒”、1.2 风险表“离线提醒”；TC-B2-69）
// • 带提醒、还没同步上的记录（outbox 状态的 remindRecs，`${table}:${id}`）：列表行尾标“未同步”小标记（UnsyncedRemindMark），
//   页面上出一行“未同步，提醒可能不响”（UnsyncedRemindHint）；不带提醒的不标、不出
// • 同步成功（服务器回执）后 outbox 把它移出 remindRecs，标记和提示自动消失；发送失败的（含另一台设备已删的 gone）也标
//   （REMIND-failed-unsynced），放弃、恢复以后按 outbox 的新状态
// • 重试（UNSYNCED-retry-ui，负责人 11-05 定方案 C）：这些记录里有发送失败、不是 gone 的项时，提示行末尾出“重试”，
//   一次重试全部（同一条记录的几项一起，保持顺序）；gone 照旧走冲突卡的“恢复”。行尾标记只显示、不能点（它在整行按钮里，按钮不能套按钮）。
//   点了以后这几项改回待发、按钮消失；焦点在按钮上时挪到提示行本身，不掉到页面开头
// • 新建失败（R-378）：不带提醒也进 remindRecs；码能重试的同样出“重试”，不能重试的出“另存为新的一条”“放弃”（FailedCreateActions，按需下载）
// • 自己不带 role="status"：读屏播报靠挂它的页面放一个常驻的 role="status" 容器、内容后填进去（提醒接线代码审查 L3：
//   live region 和内容同时插进来时 iOS VoiceOver 常常不播报）
// 小标记在 UnsyncedRemindMark.tsx；两个都由列表、今天页经 reminders 的 index.ts 懒加载挂（见交付说明的接线清单）
import { lazy, Suspense, useLayoutEffect, useRef } from 'react';
import { Pressable } from '../../../motion/components.ts';
import { useRetryUnsynced, useUnsyncedRemind } from '../hooks/useUnsynced.ts';
import { useRemindRowT } from '../hooks/useRemindRowT.ts';
import styles from './Remind.module.css';

// 新建失败、不能重试的记录的“另存为新的一条”“放弃”（R-378）：提示条里的记录比能重试的多时才下载（只待发的带提醒记录也会下载，
// 首屏代码里分不出是不是新建失败：组件自己读 outbox，没有就什么也不画）；自带 Suspense，下载期间提示文字照常显示
const FailedCreateActions = lazy(() => import('./FailedCreateActions.tsx'));

/** 页面上一行提示；有带提醒、没同步上的记录才出 */
export default function UnsyncedRemindHint() {
  const t = useRemindRowT();
  const recs = useUnsyncedRemind();
  const { recs: retryRecs, busy, retry } = useRetryUnsynced();
  const pRef = useRef<HTMLParagraphElement>(null);
  const hadFocus = useRef(false);
  const show = retryRecs.size > 0;
  // 按钮因为重试成功消失、焦点原来在它上面（元素被移除时浏览器不发 blur，hadFocus 还是 true）：放到提示行（tabIndex -1），不掉到 body
  useLayoutEffect(() => {
    if (show) return;
    if (hadFocus.current && (document.activeElement === null || document.activeElement === document.body)) pRef.current?.focus();
    hadFocus.current = false;
  }, [show]);
  if (recs.size === 0) return null;
  return (
    <p className={`${styles.dim} ${styles.unsynced}`} data-testid="remind-unsynced-hint" ref={pRef} tabIndex={-1}>
      <span>{t('remind.unsynced', {})}</span>
      {show ? (
        <Pressable
          type="button"
          className={styles.retry}
          aria-disabled={busy || undefined}
          onFocus={() => (hadFocus.current = true)}
          onBlur={() => (hadFocus.current = false)}
          onClick={retry}
          data-testid="remind-unsynced-retry"
        >
          {t('remind.unsynced.retry', {})}
        </Pressable>
      ) : null}
      {recs.size > retryRecs.size ? (
        <Suspense fallback={null}>
          <FailedCreateActions />
        </Suspense>
      ) : null}
    </p>
  );
}
