// “未同步”提示条里新建失败、码不能重试的记录的两个按钮（R-378，负责人 11-10 定：用现有提示条，不加新界面；R-376 只做最基本的）：
// “另存为新的一条”换新 id 合成一个 insert；“放弃”连同后面的修改、依赖它的项一起删（规则在 hooks/useFailedCreates.ts、core/outbox-failed-create.ts）。
// 记录全是不能另存的表（core 的 NO_COPY_TABLES：settings、note_images）时只出“放弃”：另存照样冲突（R-378 复查必改；B4 插图）。没有这样的记录就什么也不画。由 UnsyncedRemind.tsx 按需加载（提示条里的记录比能重试的多时才挂），不进首屏
import { createT } from '../../../../shared/i18n/i18n.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import { Pressable } from '../../../motion/components.ts';
import { useFailedCreates, type FailedCreateOutbox, type ResolveFailedCreate } from '../hooks/useFailedCreates.ts';
import { failedCreateKo } from '../i18n/failed-create-ko.ts';
import { failedCreateZh } from '../i18n/failed-create-zh.ts';
import styles from './Remind.module.css';

const tFc = createT({ zh: failedCreateZh, ko: failedCreateKo });

export default function FailedCreateActions({ outbox, resolve }: { outbox?: FailedCreateOutbox | null; resolve?: ResolveFailedCreate }) {
  const locale = useUi((s) => s.locale);
  const { recs, canCopy, busy, failed, run } = useFailedCreates(outbox, resolve);
  if (recs.length === 0) return null;
  return (
    <>
      {canCopy ? (
        <Pressable type="button" className={styles.retry} aria-disabled={busy || undefined} onClick={() => run('copy')} data-testid="remind-unsynced-copy">
          {tFc('remind.unsynced.copy', {}, locale)}
        </Pressable>
      ) : null}
      <Pressable type="button" className={styles.retry} aria-disabled={busy || undefined} onClick={() => run('drop')} data-testid="remind-unsynced-drop">
        {tFc('remind.unsynced.drop', {}, locale)}
      </Pressable>
      {/* 没处理成时的一句话（代码审查可选项，R-376 只做最基本的） */}
      <span role="status" data-testid="remind-unsynced-failed">
        {failed === 'dependents' ? tFc('remind.unsynced.failedDeps', {}, locale) : failed === 'other' ? tFc('remind.unsynced.failedOther', {}, locale) : null}
      </span>
    </>
  );
}
