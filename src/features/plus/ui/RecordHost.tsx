// 按住“＋”录音这一套界面挂在哪（B3 FA-3）：TypeBarPreload（首屏画完以后挂一份，懒加载块）里挂一个，不进首屏、不碰 App 和底栏
// • useVoice 挂上才接手手势（data/hold-input.ts 的 sink），没挂上之前按住“＋”只当点一下
// • 画：录音面板、松手以后的提示条、记下了的“已记下 · 撤销”（和打字条同一个 SavedNotice）、过去月日的确认行、麦克风说明卡
// • exe 不做语音（R-90）：useVoice 里按住不接手，说明卡也不会出
import { useCallback, useState } from 'react';
import type { AiItem } from '../../../../shared/schema/ai.ts';
import { usePlusLine, usePlusT } from '../hooks/usePlusT.ts';
import { useVoice, type VoiceOpts } from '../hooks/useVoice.ts';
import { ConfirmRow } from './ConfirmRow.tsx';
import MicCard, { type MicCardKind } from './MicCard.tsx';
import { RecordPanel } from './RecordPanel.tsx';
import styles from './RecordPanel.module.css';
import { SavedNotice } from './SavedNotice.tsx';
import { VoiceNotice } from './VoiceNotice.tsx';

export interface RecordHostProps extends VoiceOpts {
  /** 提示条里“修改”某一条（App 开编辑页）；不给就不出“修改” */
  onEdit?: ((table: string, id: string) => void) | undefined;
}

export function RecordHost({ onEdit, ...opts }: RecordHostProps) {
  const t = usePlusT();
  const line = usePlusLine();
  const v = useVoice(opts);
  const kind = useCallback((it: AiItem): string => t(`plus.kind.${it.kind}`, {}), [t]);
  // 说明卡关上时还要播退场：记着上一次是哪一张
  const [lastCard, setLastCard] = useState<MicCardKind>('ask');
  if (v.card !== null && v.card !== lastCard) setLastCard(v.card);
  return (
    <>
      <RecordPanel v={v} />
      <VoiceNotice v={v} />
      {v.asking ? (
        <div className={styles.note} data-testid="voice-confirm">
          <ConfirmRow item={v.asking} onChoose={(c) => void v.choose(c)} onDismiss={v.dismissConfirm} />
        </div>
      ) : null}
      {v.notice && v.note === null ? (
        <SavedNotice
          text={v.notice.lines.map((l) => line(l.key, l.params)).join(' · ')}
          rows={v.notice.entries.map((e) => ({ table: e.ref.table, id: e.ref.id, label: `${kind(e.item)} · ${e.ref.title}` }))}
          onUndoAll={() => void v.undo()}
          onUndoOne={(id) => void v.undoOne(id)}
          onMerge={() => void v.merge()}
          onEdit={onEdit}
          onClose={v.closeNotice}
        />
      ) : null}
      {/* ask：“允许麦克风”在这一下点按里申请；denied：“我已打开，再试一次”重新申请一次，还是不行就留在这张卡 */}
      <MicCard
        open={v.card !== null}
        kind={lastCard}
        onOpenChange={(o) => {
          if (!o) v.closeCard();
        }}
        onRetry={v.allowMic}
        onType={v.typeInstead}
      />
    </>
  );
}
