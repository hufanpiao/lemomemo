// 看图页（底部显示描述和标签）：点随手记里的插图才懒加载这一块
// • 手机整屏、电脑全窗口浮层：外壳和文档预览 PreviewLayer 共用 layer.module.css（scrim / full / box，看图页加 solid 不透明）和 layer.ts 的 useShellLayer（kit 层栈：焦点、Esc、滚动锁、后面 inert）
// • 顶上：“✕ 关闭”、“第几张 / 共几张”；“⋯”不画——随手记里传好了的图现在没有别的动作（删除只在没传上时出）
// • 中间：大图（由随手记传进来的 render 画，图从哪取是随手记的事）；左右滑、左右键、两边的“‹ ›”换张，到头不绕回；记的是看着的那张 id，图增删时不跳；一张都没了就关
// • 底部：这张识别好了才出“AI 看到的”卡片（描述、中韩标签、“只写是什么东西，不抄号码”）；没识别好不出东西
// • 存图（调用方给 onSave 才出）：按钮的样式和位置照附件预览 PreviewLayer（直接用它的 .tools / .btnText / .foot / .footBtn）——
//   手机底部一整条“存到相册”（分享面板里点“存储图像”；浏览器分享不了文件时写“下载”），电脑顶行右边“下载”。
//   大图长按 iOS 自带的“存储到照片”也放开（全局 base.css 为防长按选字关了 touch-callout，这里单独给大图开回来）
// • 关了焦点回到打开它的那张图（back 由调用方传入）；计数读屏念“第 n 张，共 m 张”（视觉隐藏的 live 区）
// • 缩放（hooks/useZoomPan.ts）：双指 1～4 倍、放大后单指拖、双击 1 倍和 2.5 倍切换；放大时不横滑换张，换张回到 1 倍
// • 动效：只有双击缩放的过渡，减弱动态效果时没有；其余没有
// • 运行日志：打开和换张（att view i=第几张/共几张）、放大和回到 1 倍（att view zoom in|out）、关上（att view close）；不记图和描述
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { groupLabelClass } from '../../../kit/components/Form.tsx';
import { useKeys } from '../../../kit/hooks/layers.ts';
import { MQ_SIDEBAR, useMedia } from '../../../kit/hooks/useMedia.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { Pressable } from '../../../motion/components.ts';
import { useImageAi } from '../hooks/useImageAi.ts';
import { canShareFiles, useAttT } from '../hooks/useNoteFiles.ts';
import { useZoomPan } from '../hooks/useZoomPan.ts';
import { useShellLayer } from './layer.ts';
import shell from './layer.module.css';
import pv from './PreviewLayer.module.css';
import styles from './ImageViewer.module.css';

/** 问分享面板认不认图片用的类型（插图上传时一律存成 webp，notes/data/note-images.ts） */
const SAVE_TYPE = 'image/webp';

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
  /** 存这张图：phone = 手机布局（交给分享面板存到相册），电脑直接下载；不给就不出按钮 */
  onSave?(id: string, phone: boolean): void;
}

export default function ImageViewer({ ids, start, render, back, onClose, onSave }: ImageViewerProps) {
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
  const { root, closeBtn, layer } = useShellLayer('att-view', close, back);
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

  // 左右键：登记在看图这一层上（层栈的快捷键入口），只在它是栈顶时生效；带修饰键（Alt+← 是后退、Shift）、输入法组字、别人处理过的不算
  const arrow = (d: number) => (): boolean => {
    step(d);
    return true;
  };
  useKeys({ ArrowLeft: arrow(-1), ArrowRight: arrow(1) }, layer);

  // 捏合、拖动、双击、1 倍时横滑换张都在 useZoomPan；换张回到 1 倍
  const zoom = useZoomPan(id, step);

  const closeName = t('att.pv.close', {});
  const count = t('att.iv.count', { i: i + 1, n });
  return createPortal(
    <div ref={root} className={shell.scrim} data-testid="img-view">
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
          {desk && onSave && id ? (
            <span className={pv.tools}>
              <Pressable className={pv.btnText} onClick={() => onSave(id, false)} data-testid="img-view-save">
                {t('att.download', {})}
              </Pressable>
            </span>
          ) : null}
        </div>
        <div className={styles.stage} onPointerDown={zoom.onPointerDown} onPointerMove={zoom.onPointerMove} onPointerUp={zoom.onPointerUp} onPointerCancel={zoom.onPointerCancel} data-testid="img-view-stage">
          <div ref={zoom.frame} className={styles.pic}>
            <div ref={zoom.layer} className={styles.zoom} data-testid="img-view-zoom">
              {id ? render(id) : null}
            </div>
          </div>
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
        {!desk && onSave && id ? (
          <div className={pv.foot}>
            <Pressable className={pv.footBtn} onClick={() => onSave(id, true)} data-testid="img-view-save">
              {canShareFiles(undefined, SAVE_TYPE) ? t('att.iv.save', {}) : t('att.download', {})}
            </Pressable>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}

/** 底部“AI 看到的”：只在这张识别好了时出 */
function AiSeen({ id }: { id: string }) {
  const t = useAttT();
  const v = useImageAi(id).view;
  if (v?.kind !== 'seen') return null;
  return (
    <div className={styles.seen} data-testid={`img-view-ai-${id}`}>
      <p className={`${groupLabelClass} ${styles.cap}`}>{t('att.ai.seen', {})}</p>
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
