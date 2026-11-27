// 待办编辑页顶上的一行（失败的话这条留着，点它可以重试）：
// 这一条是录音那一路松手先存的占位、本机还留着录音时才出（hooks/usePending.ts、data/voice-pending.ts）；别的待办什么都不画
// • 整理中：一行灰底小字，不出按钮（好了自动换成待办或日程）
// • 没整理成：灰底一行 +“重试”胶囊（用留着的录音再传一次，退回列表看结果）；点了、正在传时按钮禁用
// 样子照识图状态条（attachments 的 ImageAiStatus）：同一种灰底条、kit 胶囊
// 动效：只用 Pressable 的按下反馈
import chip from '../../../kit/components/Chip.module.css';
import { Pressable } from '../../../motion/components.ts';
import { usePending } from '../hooks/usePending.ts';
import { usePlusT } from '../hooks/usePlusT.ts';
import styles from './VoicePending.module.css';

export default function VoicePending({ id }: { id: string }) {
  const t = usePlusT();
  const p = usePending(id);
  if (p.state === null) return null;
  const failed = p.state !== 'tidying';
  return (
    <p className={styles.bar} role="status" data-testid="voice-pending" data-state={p.state}>
      <span className={styles.tx}>{t(failed ? 'plus.pending.failed' : 'plus.pending.tidying', {})}</span>
      {failed ? (
        <Pressable type="button" className={`${chip.chip} ${chip.onGray} ${styles.btn}`} onClick={p.retry} disabled={p.state === 'retrying'} data-testid="voice-pending-retry">
          {t('plus.pending.retry', {})}
        </Pressable>
      ) : null}
    </p>
  );
}
