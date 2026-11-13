// 随手记插图的界面（B4 S3；皮肤视觉稿 PH.mason 卡片顶部的图、NOTE_ED 抽屉里的图；主持人定的 4 件事）
// • 卡片顶部（CardCover）：16:10，铺满卡片宽，右上角“+N”（另外还有几张）；用缩略图
// • 编辑器、电脑抽屉里（EditorImages）：每张 16:10、圆角 18、上边距 14；还在传的盖一层“上传中…”；没传上的出“图片没传上”和“删除”“重新插入”
//   （重新插入：图还在内存里就再传一次；不在了——页面关过——就重新选一张，插进来后删掉旧的这张）
// • 选图（PickButtons）：“图片”（文件选择框，只收 image/*）和“拍照”（同上加 capture="environment"，手机直接开后摄像头）并排；
//   编辑器里两个都放；输入行只放“图片”一个（视觉稿第 1491 行、线框 COMPOSER“输入行插图按钮不变”，视觉验收必改 4）。input 藏起来、由按钮点开，点按区照 44
// • 提示文案（imgMessage）：插入失败（HEIC 先转 JPG、打不开、存不上……）、上传失败、写行被拒，都写进 i18n
// • 输入行选图（useAddImage；R-416：选了先挂成待记下的小图 PendingPics，点“记下”才存）、编辑器插图区连同提示（EditorImageBlock）也在这里，随手记页、编辑页不超行数上限
// • 动效：只用 Pressable 的按下反馈（R-376）
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useBlobSrc } from '../../../kit/hooks/useBlobSrc.ts';
import { hrefOf, navigate, plainClick } from '../../../app/router.ts';
import { Pressable } from '../../../motion/components.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { insertImage, useImageNotices, useImageSrc, useNoteImages, type ImageSrc, type ImgFailKey, type ImgNotice, type InsertResult, type NoteImage, type PendingImage } from '../hooks/useNoteImages.ts';
import type { ActionResult } from '../hooks/useNoteList.ts';
import { useNotesT, type NotesMsgKey } from '../hooks/useNotesT.ts';
import styles from './NoteImages.module.css';

/** 插图提示的文案键（都不带参数） */
export type ImgMsgKey = Extract<NotesMsgKey, `notes.img.fail.${string}` | `notes.img.err.${string}`>;

/** 插入失败的码 → 文案键；ok / silent 回 null */
export function insertMessage(r: InsertResult): ImgMsgKey | null {
  return r.ok || r.code === 'silent' ? null : `notes.img.err.${r.code}`;
}
export const failMessage = (k: ImgFailKey): ImgMsgKey => `notes.img.fail.${k}`;

/** 编辑器里的插图提示（保存状态下面）；空间满了的带“最近删除”入口 */
export function ImgMsgLine({ msg, className }: { msg: { key: ImgMsgKey; trash: boolean }; className: string | undefined }) {
  const t = useNotesT();
  return (
    <p className={className} role="alert" data-testid="note-edit-img-msg">
      {t(msg.key, {})}{' '}
      {msg.trash ? (
        <a href={hrefOf('trash')} onClick={(e) => plainClick(e) && void navigate('trash')} data-testid="note-edit-img-trash">
          {t('notes.img.trash', {})}
        </a>
      ) : null}
    </p>
  );
}

/** 插图按钮的图标（同视觉稿 ic('img')：相框、太阳、山） */
export function ImgIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? styles.ic} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <rect x="3.5" y="4.5" width="17" height="15" rx="3" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="M4.5 17.5l5-5 3.5 3.5 2.5-2.5 4 4" />
    </svg>
  );
}

/** 拍照的图标（机身 + 镜头） */
export function CameraIcon({ className }: { className?: string }) {
  return (
    <svg className={className ?? styles.ic} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.8l1.4-2h4.6l1.4 2h1.8A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" />
      <circle cx="12" cy="12.5" r="3.4" />
    </svg>
  );
}

/** 显示 blob: 地址的图（地址来自 data/image-view.ts、image-uploader.ts）：经 kit 的 useBlobSrc 设 src，只放行 blob:（A26 补） */
function BlobImg({ url, alt, onError }: { url: string; alt: string; onError?: () => void }) {
  const ref = useBlobSrc(url);
  return <img ref={ref} className={styles.coverImg} alt={alt} onError={onError} />;
}

/** 藏起来的选图框：pick() 点开，选了一张就回调（同一张再选也触发：选完清空 value） */
function useFilePick(onFile: (f: File) => void, camera: boolean, testId: string): [ReactNode, () => void] {
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      accept="image/*"
      capture={camera ? 'environment' : undefined}
      hidden
      tabIndex={-1}
      onChange={(e) => {
        const f = e.target.files?.[0];
        e.target.value = '';
        if (f) onFile(f);
      }}
      data-testid={testId}
    />
  );
  return [input, () => ref.current?.click()];
}

/** “图片”“拍照”两个按钮；className 给按钮（输入行沿用 .img 的 40 × 40 灰圆，编辑器用这里的胶囊） */
export function PickButtons({ onFile, disabled, className, idPrefix, camera = true }: { onFile(f: File): void; disabled?: boolean; className?: string | undefined; idPrefix: string; camera?: boolean }) {
  const t = useNotesT();
  const [pickInput, pick] = useFilePick(onFile, false, `${idPrefix}-img-input`);
  const [camInput, cam] = useFilePick(onFile, true, `${idPrefix}-camera-input`);
  const cls = className ?? styles.pick;
  return (
    <>
      <Pressable type="button" className={cls} onClick={pick} disabled={disabled} aria-label={t('notes.img', {})} data-testid={`${idPrefix}-img`}>
        <ImgIcon />
        {className ? null : <span>{t('notes.img', {})}</span>}
      </Pressable>
      {camera ? (
        <Pressable type="button" className={cls} onClick={cam} disabled={disabled} aria-label={t('notes.camera', {})} data-testid={`${idPrefix}-camera`}>
          <CameraIcon />
          {className ? null : <span>{t('notes.camera', {})}</span>}
        </Pressable>
      ) : null}
      {pickInput}
      {camera ? camInput : null}
    </>
  );
}

/** 瀑布流卡片顶部的图：16:10、右上角“+N” */
export function CardCover({ img, count }: { img: NoteImage; count: number }) {
  const t = useNotesT();
  const src = useImageSrc(img, true);
  const more = count - 1;
  const bad = failKey(src);
  return (
    <span className={styles.cover} data-testid={`notes-cover-${img.noteId}`} data-state={bad ? 'failed' : 'ok'}>
      {src.url && !bad ? <BlobImg url={src.url} alt={t('notes.img.alt', {})} /> : null}
      {bad ? <span className={styles.coverFail}>{t(bad, {})}</span> : null}
      {more > 0 ? (
        <b className={styles.more} aria-label={t('notes.img.more', { n: more })}>
          {`+${more}`}
        </b>
      ) : null}
    </span>
  );
}

/** “没传上”（本页传失败）/“还没传上”（服务器上暂时没有，可能另一台设备还在传）；正常的回 null */
function failKey(src: ImageSrc): 'notes.img.failed' | 'notes.img.notYet' | null {
  return src.failed ? 'notes.img.failed' : src.missing ? 'notes.img.notYet' : null;
}

/** 列表行“⋯”前的缩略图（视觉验收必改 1；视觉稿 PH.notes .thumb）：取不到时标“!”，读屏念出原因 */
export function ListThumb({ img }: { img: NoteImage }) {
  const t = useNotesT();
  const src = useImageSrc(img, true);
  const bad = failKey(src);
  return (
    <span className={styles.thumb} data-testid={`notes-thumb-${img.noteId}`} data-state={bad ? 'failed' : 'ok'}>
      {src.url && !bad ? <BlobImg url={src.url} alt={t('notes.img.alt', {})} /> : null}
      {bad ? (
        <span className={styles.thumbFail} role="img" aria-label={t(bad, {})}>
          !
        </span>
      ) : null}
    </span>
  );
}

type Made = { result: ActionResult; id: string | null };
type ImgMsg = { key: ImgMsgKey; trash: boolean };

/** 输入行上待记下的一张图（R-416）：key 只在本页内存里区分同一张图选两次 */
export type PendingPic = { key: number; file: File };
/** 输入行点“记下”带图时的结果：ok = 记成了一条；left = 没插成的图（放回输入行，不丢） */
export type ImagesResult = { ok: boolean; left: File[] };

/**
 * 插图（S3）：插图的失败提示都在这一页出（抽屉里插的图也是）；返回输入行点“记下”时调的函数（R-416：选了图先挂在输入行上，点“记下”才存）——
 * 第一张编码成了才用输入框里的字新建一条（可以空，只建一次），图依次插进这一条；没插成的图交回输入行；
 * 一张都没插成、输入框又没字的，刚建的空条撤销掉、按没记成算（字也放回）。整批结果记一行运行日志 notes images
 */
export function useAddImage(
  l: { add(text: string, allowEmpty?: boolean): Promise<Made>; discard(id: string): Promise<ActionResult> },
  setJust: (id: string) => void,
  report: (r: ActionResult) => void,
  notify: (m: ImgMsg) => void,
) {
  const onImgNotice = useCallback((n: ImgNotice) => notify({ key: failMessage(n.key), trash: n.key === 'quota' }), [notify]);
  useImageNotices(onImgNotice);
  return async (text: string, files: readonly File[]): Promise<ImagesResult> => {
    let made = null as Made | null;
    let once: Promise<Made> | null = null;
    const note = async () => (made = await (once ??= l.add(text, true))).id;
    const left: File[] = [];
    for (const file of files) {
      const r = await insertImage(note, file);
      if (!r.ok) left.push(file);
      const k = insertMessage(r);
      if (k) notify({ key: k, trash: false });
    }
    const m = made;
    // 输入框本来没字、图一张都没写成：刚新建的空随手记撤销掉，不留空条（代码审建议）
    const dropped = Boolean(m?.id && left.length === files.length && text.trim() === '');
    if (dropped && m?.id) void l.discard(m.id);
    else if (m?.id) setJust(m.id);
    if (m && m.id === null) report(m.result);
    rlog(`notes images n=${files.length} ok=${files.length - left.length} made=${m?.id ? 1 : 0} dropped=${dropped ? 1 : 0}`);
    return { ok: m?.id != null && !dropped, left };
  };
}

/** 输入行上待记下的图（R-416）：选了先挂在这里，“×”去掉一张；预览用本机 blob: 地址，卸下时收回。
 *  键盘操作去掉一张时，焦点移到下一张（没有就上一张）的“×”，不丢到页面最外层 */
export function PendingPics({ pics, onRemove }: { pics: readonly PendingPic[]; onRemove(key: number): void }) {
  const t = useNotesT();
  const list = useRef<HTMLUListElement>(null);
  const want = useRef<number | null>(null);
  useLayoutEffect(() => {
    const i = want.current;
    want.current = null;
    if (i === null) return;
    const dels = list.current?.querySelectorAll('button');
    (dels?.[i] ?? dels?.[i - 1])?.focus();
  }, [pics.length]);
  const remove = (key: number, i: number) => {
    if (list.current?.contains(document.activeElement) === true) want.current = i;
    onRemove(key);
  };
  return (
    <ul ref={list} className={styles.pend} aria-label={t('notes.img.pend', {})} data-testid="notes-pend">
      {pics.map((p, i) => (
        <PendPic key={p.key} file={p.file} label={t('notes.img.pendRemove', { n: i + 1 })} onRemove={() => remove(p.key, i)} testId={`notes-pend-del-${i}`} />
      ))}
    </ul>
  );
}

/** 一张待记下的小图：图本身不念（alt 空，说明在“×”的名称“去掉第 n 张图片”里） */
function PendPic({ file, label, onRemove, testId }: { file: File; label: string; onRemove(): void; testId: string }) {
  const [url, setUrl] = useState('');
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    const u = URL.createObjectURL(file);
    setUrl(u);
    setBroken(false);
    return () => URL.revokeObjectURL(u);
  }, [file]);
  return (
    <li className={styles.pendItem}>
      {/* 浏览器打不开的（电脑上的 HEIC 等）不画破图标，只留灰底方块 */}
      {url && !broken ? <BlobImg url={url} alt="" onError={() => setBroken(true)} /> : null}
      <Pressable type="button" className={styles.pendDel} onClick={onRemove} aria-label={label} data-testid={testId}>
        <span aria-hidden="true">×</span>
      </Pressable>
    </li>
  );
}

/** 编辑器里的插图区：提示（保存状态下面）+ 图 + “图片”“拍照”。上传器的提示全页共用，只认这一条随手记的图；电脑抽屉里的由随手记页出（不出两遍） */
export function EditorImageBlock({ noteId, drawer, disabled, msgClass }: { noteId: string | null; drawer: boolean; disabled: boolean; msgClass: string | undefined }) {
  const [msg, setMsg] = useState<ImgMsg | null>(null);
  const onNotice = useCallback((n: ImgNotice) => {
    if (!drawer && n.noteId === noteId) setMsg({ key: failMessage(n.key), trash: n.key === 'quota' });
  }, [drawer, noteId]);
  useImageNotices(onNotice);
  return (
    <>
      {msg ? <ImgMsgLine className={msgClass} msg={msg} /> : null}
      <EditorImages noteId={noteId} disabled={disabled} onMessage={(key) => setMsg({ key, trash: false })} />
    </>
  );
}

/** 编辑器、抽屉里的图（正文下面）+ “图片”“拍照”；message 把失败提示交给编辑器显示 */
export function EditorImages({ noteId, disabled, onMessage }: { noteId: string | null; disabled: boolean; onMessage(k: ImgMsgKey): void }) {
  const t = useNotesT();
  const im = useNoteImages(noteId);
  const insert = async (f: File): Promise<boolean> => {
    const r = await im.insert(f);
    const k = insertMessage(r);
    if (k) onMessage(k);
    return r.ok;
  };
  return (
    <div className={styles.box} data-testid="note-images" data-images={im.items.length ? '1' : '0'}>
      {im.items.length ? (
        <ul className={styles.list} aria-label={t('notes.img.list', {})}>
          {im.items.map(({ img, pending }) => (
            <OneImage key={img.id} img={img} pending={pending} disabled={disabled} onRemove={() => void im.remove(img.id)} onRetry={() => im.retry(img.id)} onReplace={insert} />
          ))}
        </ul>
      ) : null}
      <div className={styles.picks}>
        <PickButtons onFile={(f) => void insert(f)} disabled={disabled || noteId === null} idPrefix="note-edit" />
      </div>
    </div>
  );
}

function OneImage(p: { img: NoteImage; pending: PendingImage | null; disabled: boolean; onRemove(): void; onRetry(): boolean; onReplace(f: File): Promise<boolean> }) {
  const t = useNotesT();
  const src = useImageSrc(p.img, false);
  const [busy, setBusy] = useState(false);
  const [replaceInput, replace] = useFilePick((f) => {
    setBusy(true);
    void p.onReplace(f).then((ok) => {
      setBusy(false);
      if (ok) p.onRemove();
    });
  }, false, `note-image-reinsert-input-${p.img.id}`);
  const bad = failKey(src);
  const failed = bad !== null;
  const uploading = p.pending !== null && p.pending.state !== 'failed';
  return (
    <li className={styles.item} data-testid={`note-image-${p.img.id}`} data-state={failed ? 'failed' : uploading ? 'uploading' : 'done'}>
      <span className={styles.frame}>
        {src.url ? <BlobImg url={src.url} alt={t('notes.img.alt', {})} /> : null}
        {uploading ? (
          <span className={styles.veil}>
            <span className={styles.badge} role="status">
              {t('notes.img.uploading', {})}
            </span>
          </span>
        ) : null}
        {failed ? (
          <span className={styles.failBox} role="alert">
            <span>{t(bad ?? 'notes.img.failed', {})}</span>
            <span className={styles.failBtns}>
              <Pressable type="button" className={styles.failBtn} onClick={p.onRemove} disabled={p.disabled || busy} data-testid={`note-image-delete-${p.img.id}`}>
                {t('notes.img.delete', {})}
              </Pressable>
              <Pressable
                type="button"
                className={styles.failBtn}
                onClick={() => {
                  if (!p.onRetry()) replace();
                }}
                disabled={p.disabled || busy}
                data-testid={`note-image-reinsert-${p.img.id}`}
              >
                {t('notes.img.reinsert', {})}
              </Pressable>
            </span>
          </span>
        ) : null}
      </span>
      {replaceInput}
    </li>
  );
}
