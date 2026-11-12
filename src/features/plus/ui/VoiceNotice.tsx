// 松手以后的提示条（B3 FA-3；定稿线框“记下之后”T_WORK、CAT；架构 5.1 L11 离线）
// • 上传中：“正在听你说的… / N 秒录音 · 通常 1～3 秒”+“取消”+一条细进度线；拿到结果在本机存的那一下：“正在整理…”
// • 没成：一行标题、一行说明、两个按钮（线框 CAT：没听清 → 再说一次 / 改用打字；AI 没回应 → 重试 / 再说一次），右上“×”关闭
//   （线框没画“×”：留着录音的提示 2 分钟才自动关，要能自己关掉）
// • 记下了的不在这里：走打字条同一套 SavedNotice（RecordHost 画）
// • 词条按种类查表，参数在运行时才定：用 usePlusLine（同提示条）
// • 没成的用 role="alert"（新挂上的 status 区域 iOS VoiceOver 常常不读，同 UndoToast 的说明）；上传中用 status
import { FormButton } from '../../../kit/components/Form.tsx';
import type { VoiceNote, VoiceState } from '../hooks/useVoice.ts';
import { useLangNames, usePlusLine, usePlusT, type PlusMsgKey } from '../hooks/usePlusT.ts';
import styles from './RecordPanel.module.css';

type Act = 'retry' | 'again' | 'type';
type Key = PlusMsgKey;

/** 每种提示：标题、说明、按钮 */
export const NOTE_VIEW: Record<VoiceNote, { title: Key; sub: Key | null; acts: readonly Act[] }> = {
  offline: { title: 'plus.voice.offline', sub: null, acts: ['type'] },
  net_down: { title: 'plus.voice.failed', sub: 'plus.voice.netDownSub', acts: ['retry', 'type'] },
  no_speech: { title: 'plus.voice.noSpeech', sub: 'plus.voice.noSpeechSub', acts: ['again', 'type'] },
  nothing: { title: 'plus.voice.nothing', sub: null, acts: ['again', 'type'] },
  ai_failed: { title: 'plus.voice.failed', sub: 'plus.voice.failedSub', acts: ['retry', 'again'] },
  quota: { title: 'plus.voice.quota', sub: 'plus.voice.quotaSub', acts: ['again', 'type'] },
  redo: { title: 'plus.voice.redo', sub: 'plus.voice.redoSub', acts: ['again', 'type'] },
  speech_off: { title: 'plus.voice.speechOff', sub: null, acts: ['type'] },
  speech_net: { title: 'plus.voice.speechNet', sub: null, acts: ['type'] },
  rec_failed: { title: 'plus.voice.recFailed', sub: null, acts: ['type'] },
  not_heard: { title: 'plus.voice.notHeard', sub: null, acts: ['again', 'type'] },
  not_saved: { title: 'plus.voice.notSaved', sub: null, acts: ['again', 'type'] },
};

const ACT_KEY: Record<Act, Key> = { retry: 'plus.voice.retry', again: 'plus.voice.again', type: 'plus.voice.type' };

export function VoiceNotice({ v }: { v: VoiceState }) {
  const t = usePlusT();
  const line = usePlusLine();
  const { lang } = useLangNames();
  if (v.note !== null) {
    const view = NOTE_VIEW[v.note];
    const run: Record<Act, () => void> = { retry: v.retry, again: v.sayAgain, type: v.typeInstead };
    return (
      <div className={styles.note} role="alert" data-testid="voice-notice" data-note={v.note}>
        <div className={styles.noteRow}>
          <div className={styles.noteText}>
            <div className={styles.t1}>{line(view.title, {})}</div>
            {view.sub === null ? null : <div className={styles.t2}>{line(view.sub, { lang })}</div>}
          </div>
          <button type="button" className={styles.x} aria-label={t('plus.voice.close', {})} onClick={v.closeNote} data-testid="voice-notice-close">
            ×
          </button>
        </div>
        <div className={styles.noteActs}>
          {view.acts.map((a, i) => (
            <FormButton key={a} type="button" size="compact" variant={i === 0 ? 'primary' : 'secondary'} onClick={run[a]} data-testid={`voice-${a}`}>
              {line(ACT_KEY[a], {})}
            </FormButton>
          ))}
        </div>
      </div>
    );
  }
  const working = v.status === 'uploading';
  if (!working && v.status !== 'organizing') return null;
  return (
    <div className={styles.note} role="status" data-testid="voice-work" data-status={v.status}>
      <div className={styles.noteRow}>
        <div className={styles.noteText}>
          <div className={styles.t1}>{t(working ? 'plus.voice.work' : 'plus.voice.organizing', {})}</div>
          {working ? <div className={styles.t2}>{t('plus.voice.workSub', { n: v.secs })}</div> : null}
        </div>
        {working ? (
          <FormButton type="button" size="compact" onClick={v.cancelUpload} data-testid="voice-cancel">
            {t('plus.voice.cancel', {})}
          </FormButton>
        ) : null}
      </div>
      <div className={styles.track} aria-hidden="true">
        <i />
      </div>
    </div>
  );
}
