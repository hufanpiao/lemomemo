// 随手记编辑器里每张图下面的识别状态（B4b-2 识图；线框 sAIst 第二屏三种状态）。
// 懒加载：notes 的 NoteImages.tsx 经 attachments/index.ts 的 ImageAiStatus 挂，上传中、没传上时不挂。
// • 识图中：一行灰底小字，不打扰（不出按钮）
// • 没识别：灰底一行 +“重新识别”；点了等回答时按钮禁用，没连上在下面出一行提示
// • 没交给 AI：灰底一行 +“去打开”（设置 › 语音与 AI）
// • 识别好了：这里不出东西（线框原话“好了就消失”）；描述和标签在看图页底部（ui/ImageViewer.tsx）
// 动效：只用 Pressable 的按下反馈（R-376）
import { Pressable } from '../../../motion/components.ts';
import { useAttT } from '../hooks/useNoteFiles.ts';
import { useImageAi } from '../hooks/useImageAi.ts';
import styles from './ImageAiStatus.module.css';

export default function ImageAiStatus({ id }: { id: string }) {
  const t = useAttT();
  const s = useImageAi(id);
  const v = s.view;
  if (!v) return null;
  // 识别好了：编辑器里不出东西，“AI 看到的”只在看图页底部（ImageViewer）
  if (v.kind === 'seen') return null;
  const text = v.kind === 'pending' ? 'att.ai.pending' : v.kind === 'failed' ? 'att.ai.failed' : v.kind === 'off' ? 'att.ai.off' : 'att.ai.other';
  return (
    <div data-testid={`img-ai-${id}`} data-ai={v.kind}>
      <p className={styles.bar} role="status">
        <span className={styles.tx}>{t(text, {})}</span>
        {v.kind === 'failed' ? (
          <Pressable type="button" className={styles.btn} onClick={s.retry} disabled={s.busy} data-testid={`img-ai-retry-${id}`}>
            {t('att.ai.retry', {})}
          </Pressable>
        ) : null}
        {v.kind === 'off' ? (
          <Pressable type="button" className={styles.btn} onClick={s.open} data-testid={`img-ai-open-${id}`}>
            {t('att.ai.open', {})}
          </Pressable>
        ) : null}
      </p>
      {s.retryFailed ? (
        <p className={styles.err} role="alert">
          {t('att.ai.retryFail', {})}
        </p>
      ) : null}
    </div>
  );
}
