// 附件预览浮层（B4b-1；线框 sPrev；架构 5.13 第 3 点）：点了“预览”才懒加载这一块
// • 电脑：全窗口浮层（四边留白、圆角），顶行“类型 · 文件名 · 大小 ｜ ‹ 第 p / n 页 › ｜ － 100% ＋ ｜ 下载 ｜ ✕ Esc”；Excel 底部切换工作表、超过 2000 行 × 50 列出提示
//   手机：整屏，顶行“✕ · 文件名”，底部“下载”（iPhone 主屏幕版的“下载”就是交给系统分享菜单，即“用其他 App 打开”，见交回报告）
// • 本机预览（PDF、Word、Excel、PPT 退路）：取字节（data/attach-open.ts 核 sha256）→ 嵌没有来源的预览沙箱（sandbox="allow-scripts"，/app/preview）→
//   等 ready 再把字节转移进去；只认 event.source 是这个 iframe、过了 parseFromFrame 的消息
// • PPT：每台设备第一次先问“预览（交给微软）/ 只下载”（data/ms-pref.ts）；交给微软时嵌 view.officeapps.live.com（不给 allow-popups、不带 referrer）；
//   20 秒没加载出来，改成本机沙箱里的“首页缩略图 + 每页文字”，顶部写“微软这次没打开”，带“再试一次”
// • Esc、✕ 关；打开时焦点放到关闭按钮，关了还给原来的元素；锁住后面页面的滚动。盖在整个窗口上（portal 到 body，不受抽屉的 transform 影响）
// • 运行日志：打开（way、结果码）、微软问答和超时；不记文件名
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useScrollLock } from '../../../kit/components/Dialog.tsx';
import { useUi } from '../../../kit/state/ui-store.ts';
import { Pressable } from '../../../motion/components.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { parseFromFrame, ZOOM_MAX, ZOOM_MIN, type FrameWay, type FromFrame, type ToFrame } from '../../../../shared/logic/files/preview-protocol.ts';
import { markOf, msViewerUrl, openBytes, previewOf, readMsPref, sizeText, useAttT, writeMsPref, type AttMsgKey, type NoteFile } from '../hooks/useNoteFiles.ts';
import { safeHref } from '../../../../shared/logic/link.ts';
import styles from './PreviewLayer.module.css';

/** 微软多久没加载出来就退回本机 */
export const MS_TIMEOUT_MS = 20_000;
const ZOOM_STEP = 25;

type State = Extract<FromFrame, { t: 'state' }>;
type Phase = { k: 'ask' } | { k: 'ms'; url: string } | { k: 'local'; way: FrameWay; bytes: ArrayBuffer; fallback: boolean } | { k: 'loading' };

export interface PreviewLayerProps {
  file: NoteFile;
  desk: boolean;
  onClose(): void;
  onDownload(): void;
  /** 打不开：交回附件区出提示，浮层随即关掉 */
  onFail(key: AttMsgKey): void;
}

export default function PreviewLayer({ file, desk, onClose, onDownload, onFail }: PreviewLayerProps) {
  const t = useAttT();
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const [st, setSt] = useState<State | null>(null);
  const live = useRef(true);
  const closeBtn = useRef<HTMLButtonElement>(null);
  const back = useRef<Element | null>(null);
  const way = previewOf(file.kind);
  useScrollLock(true);

  const fail = useCallback((key: AttMsgKey, code: string) => {
    rlog(`att preview fail way=${way ?? 'none'} code=${code}`);
    onFail(key);
    onClose();
  }, [onClose, onFail, way]);

  const local = useCallback(async (w: FrameWay, fallback: boolean) => {
    setPhase({ k: 'loading' });
    setSt(null);   // 上一次沙箱报的页数、工作表、截断提示不沿用（整块评审第 13 条）
    const r = await openBytes(file);
    if (!live.current) return;
    if (!r.ok) return fail(`att.open.${r.why}`, r.why);
    setPhase({ k: 'local', way: w, bytes: r.bytes, fallback });
  }, [file, fail]);

  const ms = useCallback(async () => {
    setPhase({ k: 'loading' });
    setSt(null);
    const url = await msViewerUrl(file);
    if (!live.current) return;
    if (url === null) return void local('pptx', true);
    setPhase({ k: 'ms', url });
  }, [file, local]);

  useLayoutEffect(() => {
    live.current = true;   // 开发版 StrictMode 会挂、卸、再挂一遍：再挂时改回 true（整块评审第 3 条）
    back.current = document.activeElement;
    closeBtn.current?.focus();
    return () => {
      live.current = false;
      const el = back.current;
      if (el instanceof HTMLElement && el.isConnected) el.focus();
    };
  }, []);

  useEffect(() => {
    if (way === null) return;
    if (way !== 'ms') return void local(way, false);
    const pref = readMsPref();
    if (pref === 'yes') void ms();
    else if (pref === 'no') {
      onDownload();
      onClose();
    } else setPhase({ k: 'ask' });
    // 只在打开时决定一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onClose]);

  const answer = (yes: boolean): void => {
    writeMsPref(yes ? 'yes' : 'no');
    rlog(`att ms ask ${yes ? 'yes' : 'no'}`);
    if (yes) void ms();
    else {
      onDownload();
      onClose();
    }
  };

  const frame = useRef<HTMLIFrameElement>(null);
  const send = (m: ToFrame): void => frame.current?.contentWindow?.postMessage(m, '*');
  const pages = st?.pages ?? 0;
  const page = st?.page ?? 1;
  const zoom = st?.zoom ?? 100;
  const paged = phase.k === 'local' && (phase.way === 'pdf' || phase.way === 'pptx') && pages > 1;
  const zoomable = phase.k === 'local' && phase.way !== 'pptx';

  return createPortal(
    <div className={styles.scrim} data-testid="att-preview">
      <div className={desk ? styles.box : styles.full} role="dialog" aria-modal="true" aria-label={t('att.pv.frame', {})}>
        <div className={styles.top}>
          <span className={styles.mark} aria-hidden="true">
            {markOf(file.kind)}
          </span>
          <b className={styles.name}>{file.name}</b>
          {desk ? <span className={styles.meta}>{phase.k === 'ms' ? t('att.ms.given', {}) : phase.k === 'local' && phase.way === 'xlsx' ? `${sizeText(file.bytes)} · ${t('att.pv.xlsx', {})}` : sizeText(file.bytes)}</span> : null}
          <span className={styles.tools}>
            {paged ? (
              <>
                <Pressable className={styles.btn} onClick={() => send({ t: 'page', n: page - 1 })} disabled={page <= 1} aria-label={t('att.pv.prev', {})} data-testid="att-pv-prev">
                  ‹
                </Pressable>
                <span className={styles.page} data-testid="att-pv-page">
                  {t('att.pv.page', { p: page, n: pages })}
                </span>
                <Pressable className={styles.btn} onClick={() => send({ t: 'page', n: page + 1 })} disabled={page >= pages} aria-label={t('att.pv.next', {})} data-testid="att-pv-next">
                  ›
                </Pressable>
              </>
            ) : null}
            {zoomable && desk ? (
              <>
                <Pressable className={styles.btn} onClick={() => send({ t: 'zoom', z: Math.max(ZOOM_MIN, zoom - ZOOM_STEP) })} disabled={zoom <= ZOOM_MIN} aria-label={t('att.pv.zoomOut', {})} data-testid="att-pv-zoom-out">
                  －
                </Pressable>
                <span className={styles.page} data-testid="att-pv-zoom">{`${zoom}%`}</span>
                <Pressable className={styles.btn} onClick={() => send({ t: 'zoom', z: Math.min(ZOOM_MAX, zoom + ZOOM_STEP) })} disabled={zoom >= ZOOM_MAX} aria-label={t('att.pv.zoomIn', {})} data-testid="att-pv-zoom-in">
                  ＋
                </Pressable>
              </>
            ) : null}
            {desk ? (
              <Pressable className={styles.btnText} onClick={onDownload} data-testid="att-pv-download">
                {t('att.download', {})}
              </Pressable>
            ) : null}
            <button ref={closeBtn} type="button" className={styles.btn} onClick={onClose} aria-label={t('att.pv.close', {})} data-testid="att-pv-close">
              {desk ? '✕ Esc' : '✕'}
            </button>
          </span>
        </div>
        {phase.k === 'local' && phase.fallback ? (
          <p className={styles.banner} data-testid="att-pv-fallback">
            {t('att.ms.fallback', {})}
            <Pressable className={styles.btnText} onClick={() => void ms()} data-testid="att-pv-again">
              {t('att.ms.again', {})}
            </Pressable>
          </p>
        ) : null}
        {st?.clipped ? <p className={styles.banner}>{t('att.pv.clipped', {})}</p> : null}
        <div className={styles.body}>
          {phase.k === 'loading' ? <p className={styles.wait}>{t('att.pv.loading', {})}</p> : null}
          {phase.k === 'ask' ? <MsAsk onAnswer={answer} /> : null}
          {phase.k === 'ms' ? <MsFrame url={phase.url} onTimeout={() => void local('pptx', true)} /> : null}
          {phase.k === 'local' ? <SandboxFrame key={`${phase.way}-${phase.fallback ? 1 : 0}`} frame={frame} way={phase.way} bytes={phase.bytes} onState={setSt} onError={(why) => fail(`att.open.${why}`, why)} /> : null}
        </div>
        {st && st.sheets.length > 1 ? (
          <div className={styles.sheets} role="tablist" aria-label={t('att.pv.sheets', {})}>
            {st.sheets.map((s, i) => (
              <button key={s} type="button" role="tab" aria-selected={i === st.sheet} className={i === st.sheet ? styles.sheetOn : styles.sheet} onClick={() => send({ t: 'sheet', i })} data-testid={`att-pv-sheet-${i}`}>
                {s}
              </button>
            ))}
          </div>
        ) : null}
        {desk ? null : (
          <div className={styles.foot}>
            <Pressable className={styles.footBtn} onClick={onDownload} data-testid="att-pv-download">
              {t('att.download', {})}
            </Pressable>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** 第一次预览 PPT：先问（线框 sPrev 第二张） */
function MsAsk({ onAnswer }: { onAnswer(yes: boolean): void }) {
  const t = useAttT();
  return (
    <div className={styles.ask} data-testid="att-ms-ask">
      <b className={styles.askTitle}>{t('att.ms.title', {})}</b>
      <p className={styles.askBody}>{t('att.ms.body', {})}</p>
      <Pressable className={styles.askYes} onClick={() => onAnswer(true)} data-testid="att-ms-yes">
        {t('att.ms.yes', {})}
      </Pressable>
      <Pressable className={styles.askNo} onClick={() => onAnswer(false)} data-testid="att-ms-no">
        {t('att.ms.no', {})}
      </Pressable>
      <small className={styles.askOnce}>{t('att.ms.once', {})}</small>
    </div>
  );
}

/** 微软在线预览：加载好之前写“正在用微软预览…”，MS_TIMEOUT_MS 还没加载出来就退回本机 */
function MsFrame({ url, onTimeout }: { url: string; onTimeout(): void }) {
  const t = useAttT();
  const [loaded, setLoaded] = useState(false);
  const cb = useRef(onTimeout);
  cb.current = onTimeout;
  useEffect(() => {
    if (loaded) return undefined;
    const tm = setTimeout(() => {
      rlog('att ms timeout');
      cb.current();
    }, MS_TIMEOUT_MS);
    return () => clearTimeout(tm);
  }, [loaded]);
  return (
    <>
      {loaded ? null : <p className={styles.wait}>{t('att.ms.loading', {})}</p>}
      <iframe
        className={loaded ? styles.frame : styles.frameHidden}
        src={safeHref(url)}
        title={t('att.pv.frame', {})}
        sandbox="allow-scripts allow-same-origin"
        referrerPolicy="no-referrer"
        onLoad={() => {
          rlog('att ms loaded');
          setLoaded(true);
        }}
        data-testid="att-ms-frame"
      />
    </>
  );
}

/** 本机预览沙箱：等它回 ready 再把字节转移进去；只认这个 iframe 发来的、形状对的消息 */
function SandboxFrame(p: { frame: React.RefObject<HTMLIFrameElement | null>; way: FrameWay; bytes: ArrayBuffer; onState(s: State): void; onError(why: 'bad_archive' | 'render'): void }) {
  const t = useAttT();
  const lang = useUi((s) => s.locale);
  const cbs = useRef(p);
  cbs.current = p;
  useEffect(() => {
    let sent = false;
    let logged = false;
    const on = (e: MessageEvent): void => {
      const win = cbs.current.frame.current?.contentWindow;
      if (!win || e.source !== win) return;
      const m = parseFromFrame(e.data);
      if (!m) return;
      if (m.t === 'ready' && !sent) {
        sent = true;
        const b = cbs.current.bytes.slice(0);   // 交出的是副本：bytes 是缓存里那一份，退路重挂时还要再发
        win.postMessage({ t: 'open', way: cbs.current.way, bytes: b, lang: lang === 'ko-KR' ? 'ko' : 'zh' } satisfies ToFrame, '*', [b]);
      } else if (m.t === 'state') {
        if (!logged) rlog(`att preview open way=${cbs.current.way} ok pages=${m.pages}`);
        logged = true;
        cbs.current.onState(m);
      } else if (m.t === 'error') cbs.current.onError(m.why);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, [lang]);
  return <iframe ref={p.frame} className={styles.frame} src="/app/preview" title={t('att.pv.frame', {})} sandbox="allow-scripts" data-testid="att-pv-frame" />;
}
