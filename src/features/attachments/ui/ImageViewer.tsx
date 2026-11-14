// 看图页（B4b-2 识图退回整改；线框 sAIst 第一屏、d 屏“看图浮层底部显示描述和标签”）：点随手记里的插图才懒加载这一块
// • 手机整屏、电脑全窗口浮层：外壳和文档预览 PreviewLayer 共用 layer.module.css（scrim / full / box，看图页加 solid 不透明）和 layer.ts 的 useLayer（焦点、Esc、滚动锁、后面 inert）
// • 顶上：“✕ 关闭”、“第几张 / 共几张”；“⋯”不画——随手记里传好了的图现在没有别的动作（删除只在没传上时出）
// • 中间：大图（由随手记传进来的 render 画，图从哪取是随手记的事）；左右滑、左右键、两边的“‹ ›”换张，到头不绕回；记的是看着的那张 id，图增删时不跳；一张都没了就关
// • 底部：这张识别好了才出“AI 看到的”卡片（描述、中韩标签、“只写是什么东西，不抄号码”）；没识别好不出东西
// • 关了焦点回到打开它的那张图（back 由调用方传入）；计数读屏念“第 n 张，共 m 张”（视觉隐藏的 live 区）
// • 动效：没有（R-376）
// • 运行日志：打开和换张（att view i=第几张/共几张）、关上（att view close）；不记图和描述
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { MQ_SIDEBAR, useMedia } from '../../../kit/hooks/useMedia.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { useImageAi } from '../hooks/useImageAi.ts';
import { useAttT } from '../hooks/useNoteFiles.ts';
import { useLayer } from './layer.ts';
import shell from './layer.module.css';
import styles from './ImageViewer.module.css';

/** 横向滑多远算换张（像素） */
const SWIPE_PX = 48;

export interface ImageViewerProps {
  /** 这条随手记的图（note_images 的 id），按显示顺序 */
  ids: readonly string[];
  /** 先看第几张（从 0 起） */
  start: number;
  /** 画 id 这张大图 */
  render(id: string): ReactNode;
  /** 打开它的元素：关了焦点回到这里 */
  back: HTMLElement | null;
  onClose(): void;
}

export default function ImageViewer({ ids, start, render, back, onClose }: ImageViewerProps) {
  const t = useAttT();
  const desk = useMedia(MQ_SIDEBAR);
  const n = ids.length;
  // 记“正在看哪一张”的 id（和当时的位置），不只记下标：同步下来前面插了图、删了别的图，看着的这张不变；
  // 这张没了（另一台设备删了）：停在原来的位置上，夹到范围里
  const [cur, setCur] = useState(() => {
    const at = Math.min(Math.max(start, 0), n - 1);
    return { id: ids[at] ?? '', at };
  });
  const found = ids.indexOf(cur.id);
  const i = found >= 0 ? found : Math.max(Math.min(cur.at, n - 1), 0);
  const id = ids[i];
  const close = useCallback(() => {
    rlog('att view close');
    onClose();
  }, [onClose]);
  const closeBtn = useLayer(close, back);
  const down = useRef<{ x: number; y: number } | null>(null);
  const now = useRef({ ids, i });
  useLayoutEffect(() => {
    now.current = { ids, i };
  });

  const step = useCallback((d: number) => {
    const { ids: list, i: k } = now.current;
    const at = Math.min(Math.max(k + d, 0), list.length - 1);
    const next = list[at];
    if (next !== undefined) setCur({ id: next, at });
  }, []);

  // 一张都没有了（全删了）：关掉
  useEffect(() => {
    if (n === 0) close();
  }, [n, close]);

  // 打开和每次换张各记一行：看的是第几张、共几张
  useEffect(() => {
    if (n > 0) rlog(`att view i=${i + 1}/${n}`);
  }, [i, n]);

  // 左右键：和 Esc 一样在 layout 阶段挂上（layer.ts）；带修饰键（Alt+← 是后退）、输入法组字、别人处理过的不算
  useLayoutEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [step]);

  // 横滑：只认主指针（双指缩放的第二根手指不算）、鼠标只认左键
  const onDown = (e: PointerEvent): void => {
    down.current = e.isPrimary && e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  };
  const onUp = (e: PointerEvent): void => {
    const d = down.current;
    down.current = null;
    if (!d || !e.isPrimary) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) >= SWIPE_PX && Math.abs(dx) > Math.abs(e.clientY - d.y)) step(dx < 0 ? 1 : -1);
  };

  const closeName = t('att.pv.close', {});
  const count = t('att.iv.count', { i: i + 1, n });
  return createPortal(
    <div className={shell.scrim} data-testid="img-view">
      <div className={`${desk ? shell.box : shell.full} ${shell.solid}`} role="dialog" aria-modal="true" aria-label={t('att.iv.frame', {})} data-shell={desk ? 'box' : 'full'}>
        <div className={styles.top}>
          <button ref={closeBtn} type="button" className={styles.close} onClick={close} aria-label={closeName} data-testid="img-view-close">
            <span aria-hidden="true">✕</span> {desk ? 'Esc' : closeName}
          </button>
          <span className={styles.count} aria-hidden="true" data-testid="img-view-count">
            {`${i + 1} / ${n}`}
          </span>
          <span className={styles.sr} aria-live="polite" data-testid="img-view-count-sr">
            {count}
          </span>
        </div>
        <div className={styles.stage} onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => (down.current = null)} data-testid="img-view-stage">
          <div className={styles.pic}>{id ? render(id) : null}</div>
          {n > 1 ? (
            <>
              <button type="button" className={`${styles.nav} ${styles.prev}`} onClick={() => step(-1)} disabled={i === 0} aria-label={t('att.iv.prev', {})} data-testid="img-view-prev">
                ‹
              </button>
              <button type="button" className={`${styles.nav} ${styles.next}`} onClick={() => step(1)} disabled={i === n - 1} aria-label={t('att.iv.next', {})} data-testid="img-view-next">
                ›
              </button>
            </>
          ) : null}
        </div>
        {id ? <AiSeen key={id} id={id} /> : null}
      </div>
    </div>,
    document.body,
  );
}

/** 底部“AI 看到的”：只在这张识别好了时出（线框 sAIst 第一屏） */
function AiSeen({ id }: { id: string }) {
  const t = useAttT();
  const v = useImageAi(id).view;
  if (v?.kind !== 'seen') return null;
  return (
    <div className={styles.seen} data-testid={`img-view-ai-${id}`}>
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
