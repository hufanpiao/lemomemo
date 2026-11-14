// 随手记编辑器里每张图下面的识别状态（B4b-2 识图；线框 sAIst 第二屏三种状态 + 第一屏“AI 看到的”）。
// 懒加载：notes 的 NoteImages.tsx 经 attachments/index.ts 的 ImageAiStatus 挂，上传中、没传上时不挂。
// • 识图中：一行灰底小字，不打扰（不出按钮）
// • 没识别：灰底一行 +“重新识别”；点了等回答时按钮禁用，没连上在下面出一行提示
// • 没交给 AI：灰底一行 +“去打开”（设置 › 语音与 AI）
// • 识别好了：“AI 看到的”+ 一句描述 + 标签胶囊 + 说明“只写是什么东西，不抄号码”（线框是看图页底部；本版没有看图页，放在编辑器图片下面）
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
  if (v.kind === 'seen') {
    return (
      <div className={styles.seen} data-testid={`img-ai-${id}`} data-ai="seen">
        <p className={styles.cap}>{t('att.ai.seen', {})}</p>
        <p className={styles.desc}>{v.desc}</p>
        {v.tags.length ? (
          <ul className={styles.tags} aria-label={t('att.ai.tags', {})}>
            {v.tags.map((x) => (
              <li key={x} className={styles.tag}>
                {x}
              </li>
            ))}
          </ul>
        ) : null}
        <p className={styles.hint}>{t('att.ai.hint', {})}</p>
      </div>
    );
  }
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
