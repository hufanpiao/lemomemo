// 随手记插图的界面
// • 卡片顶部（CardCover）：16:10，铺满卡片宽，右上角“+N”（另外还有几张）；用缩略图
// • 编辑器、电脑抽屉里（EditorImages）：每张 16:10、圆角 18；还在传的盖一层“上传中…”；没传上的出“图片没传上”和“删除”“重新插入”；
//   传好了的下面挂识别状态（attachments 的 ImageAiStatus，懒加载）；点传好了的图打开看图页（NoteImageView）
//   （重新插入：图还在内存里就再传一次；不在了——页面关过——就重新选一张，插进来后删掉旧的这张）
// • 选图（PickButtons）：“图片”（文件选择框，只收 image/*）和“拍照”（同上加 capture="environment"，手机直接开后摄像头）并排；
//   编辑器里两个都放（手机整页在底部浮动工具条里，电脑抽屉在图下面）；输入行只放“图片”一个。input 藏起来、由按钮点开，点按区照 44
// • 提示（insertTip、noticeTip，输入行和编辑器共用）：插入失败（HEIC 先转 JPG、打不开、存不上……）、上传失败、写行被拒，都写进 i18n；空间满了的带“最近删除”（ImgTrashLink，按来源去随手记或隐私记的最近删除）
// • 输入行选图（useAddImage：选了先挂成待记下的小图 PendingPics，点“记下”才存）、编辑器插图区连同提示（EditorImageBlock）也在这里，随手记页、编辑页不超行数上限
// • 动效：只用 Pressable 的按下反馈
// • 图、取图、插图、提示都经 hooks/note-source.ts 的来源：隐私记的图点开同样进看图页；识图状态只在 caps.ai 时挂
import { Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react';
import { ImageAiStatus } from '../../attachments/index.ts';
import { NoteImageView, type ViewOpen } from './NoteImageView.tsx';
import { BlobImg, CameraIcon, failKey, ImgIcon } from './ImgParts.tsx';
import { TrashLink } from '../../../kit/components/TrashLink.tsx';
import { Pressable } from '../../../motion/components.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { useNoteSource } from '../hooks/note-source.ts';
import { useImageNotices, type ImgNotice, type InsertResult, type NoteImage, type PendingImage } from '../hooks/useNoteImages.ts';
import type { ActionResult } from '../hooks/useNoteList.ts';
import { useNotesT, type NotesMsgKey } from '../hooks/useNotesT.ts';
import chip from '../../../kit/components/Chip.module.css';
import styles from './NoteImages.module.css';

/** 插图提示的文案键（都不带参数） */
export type ImgMsgKey = Extract<NotesMsgKey, `notes.img.fail.${string}` | `notes.img.err.${string}`>;

/** 一句插图提示：文案键 + 带不带“最近删除”入口（空间满了的才带） */
type ImgMsg = { key: ImgMsgKey; trash: boolean };

/** 插入结果 → 提示（输入行、编辑器两处插图共用）；ok / silent 不提示，回 null */
const insertTip = (r: InsertResult): ImgMsg | null => (r.ok || r.code === 'silent' ? null : { key: `notes.img.err.${r.code}`, trash: false });
/** 来源报来的失败（插入、上传、写行被拒）→ 提示；空间满了的带“最近删除”入口 */
const noticeTip = (n: ImgNotice): ImgMsg => ({ key: `notes.img.fail.${n.key}`, trash: n.key === 'quota' });

/** 插图提示里的“去最近删除”行内链接（编辑器提示行、随手记页输入行上面的提示条共用）：去哪按来源走——
 *  随手记去全站最近删除的随手记一类 #/trash/notes，隐私记去自己的 #/vault/trash（hooks/note-source.ts 的 trash，和顶栏垃圾桶图标同一份） */
export function ImgTrashLink({ testId }: { testId: string }) {
  const t = useNotesT();
  const { trash } = useNoteSource();
  return <TrashLink look="inline" to={trash} label={t('notes.img.trash', {})} testId={testId} />;
}

/** 编辑器里的插图提示（保存状态下面）；空间满了的带“最近删除”入口 */
function ImgMsgLine({ msg, className }: { msg: ImgMsg; className: string | undefined }) {
  const t = useNotesT();
  return (
    <p className={className} role="alert" data-testid="note-edit-img-msg">
      {t(msg.key, {})}
      {msg.trash ? <ImgTrashLink testId="note-edit-img-trash" /> : null}
    </p>
  );
}

/** 藏起来的选图框：pick() 点开，选了就按选的顺序一张张回调，上一张的回调（可能是插图的 Promise）完了再交下一张，顺序不乱
 *  （同一张再选也触发：选完清空 value）。“图片”一次可选多张；拍照、“重新插入”一次一张 */
function useFilePick(onFile: (f: File) => unknown, mode: 'many' | 'one' | 'camera', testId: string): [ReactNode, () => void] {
  const ref = useRef<HTMLInputElement>(null);
  const input = (
    <input
      ref={ref}
      type="file"
      accept="image/*"
      multiple={mode === 'many'}
      capture={mode === 'camera' ? 'environment' : undefined}
      hidden
      tabIndex={-1}
      onChange={(e) => {
        const fs = [...(e.target.files ?? [])];
        e.target.value = '';
        // 回调是同步的（输入行挂小图）就当场一张张交，选完马上点“记下”也带得上；回调回了 Promise（编辑器插图）才排在它后面
        let last: unknown;
        for (const f of fs) last = last instanceof Promise ? last.then(() => onFile(f)) : onFile(f);
      }}
      data-testid={testId}
    />
  );
  return [input, () => ref.current?.click()];
}

/** “图片”“拍照”两个按钮；className 给按钮（输入行沿用 .img 的 40 × 40 灰圆，只有图标；编辑页底部工具条的 labeled 带字）；只有图标时才加 aria-label（带字的读屏直接读字）；
 *  不给时是电脑抽屉里的 kit 胶囊（Chip.module.css .chip，不再照抄一份胶囊样式） */
export function PickButtons({ onFile, disabled, className, labeled = !className, idPrefix, camera = true }: { onFile(f: File): unknown; disabled?: boolean; className?: string | undefined; labeled?: boolean; idPrefix: string; camera?: boolean }) {
  const t = useNotesT();
  const [pickInput, pick] = useFilePick(onFile, 'many', `${idPrefix}-img-input`);
  const [camInput, cam] = useFilePick(onFile, 'camera', `${idPrefix}-camera-input`);
  const cls = className ?? chip.chip;
  return (
    <>
      <Pressable type="button" className={cls} onClick={pick} disabled={disabled} {...(labeled ? {} : { 'aria-label': t('notes.img', {}) })} data-testid={`${idPrefix}-img`}>
        <ImgIcon />
        {labeled ? <span>{t('notes.img', {})}</span> : null}
      </Pressable>
      {camera ? (
        <Pressable type="button" className={cls} onClick={cam} disabled={disabled} {...(labeled ? {} : { 'aria-label': t('notes.camera', {}) })} data-testid={`${idPrefix}-camera`}>
          <CameraIcon />
          {labeled ? <span>{t('notes.camera', {})}</span> : null}
        </Pressable>
      ) : null}
      {pickInput}
      {camera ? camInput : null}
    </>
  );
}

/** 卡片顶部的图、列表行缩略图共用：取缩略图（box 是图所在的元素，隐私记只取看得见的）、取到了的 <img>、取不到的原因（文案键） */
function useThumb(img: NoteImage) {
  const t = useNotesT();
  const box = useRef<HTMLSpanElement>(null);
  const src = useNoteSource().useImageSrc(img, true, box);
  const bad = failKey(src);
  const pic = src.url && !bad ? <BlobImg url={src.url} alt={t('notes.img.alt', {})} /> : null;
  return { t, box, bad, pic, state: bad ? 'failed' : 'ok' };
}

/** 瀑布流卡片顶部的图：16:10、右上角“+N” */
export function CardCover({ img, count }: { img: NoteImage; count: number }) {
  const { t, box, bad, pic, state } = useThumb(img);
  const more = count - 1;
  return (
    <span ref={box} className={styles.cover} data-testid={`notes-cover-${img.noteId}`} data-state={state}>
      {pic}
      {bad ? <span className={styles.coverFail}>{t(bad, {})}</span> : null}
      {more > 0 ? (
        <b className={styles.more} aria-label={t('notes.img.more', { n: more })}>
          {`+${more}`}
        </b>
      ) : null}
    </span>
  );
}

/** 列表行“⋯”前的缩略图：取不到时标“!”，读屏念出原因 */
export function ListThumb({ img }: { img: NoteImage }) {
  const { t, box, bad, pic, state } = useThumb(img);
  return (
    <span ref={box} className={styles.thumb} data-testid={`notes-thumb-${img.noteId}`} data-state={state}>
      {pic}
      {bad ? (
        <span className={styles.thumbFail} role="img" aria-label={t(bad, {})}>
          !
        </span>
      ) : null}
    </span>
  );
}

type Made = { result: ActionResult; id: string | null };

/** 输入行上待记下的一张图：key 只在本页内存里区分同一张图选两次 */
export type PendingPic = { key: number; file: File };
/** 输入行点“记下”带图时的结果：ok = 记成了一条；left = 没插成的图（放回输入行，不丢） */
export type ImagesResult = { ok: boolean; left: File[] };

/**
 * 插图：插图的失败提示都在这一页出（抽屉里插的图也是）；返回输入行点“记下”时调的函数（选了图先挂在输入行上，点“记下”才存）——
 * 第一张编码成了才用输入框里的字新建一条（可以空，只建一次），图依次插进这一条；没插成的图交回输入行；
 * 一张都没插成、输入框又没字的，刚建的空条撤销掉、按没记成算（字也放回）。整批结果记一行运行日志 notes images
 */
export function useAddImage(
  l: { add(text: string, allowEmpty?: boolean): Promise<Made>; discard(id: string): Promise<ActionResult> },
  setJust: (id: string) => void,
  report: (r: ActionResult) => void,
  notify: (m: ImgMsg) => void,
) {
  const src = useNoteSource();
  const onImgNotice = useCallback((n: ImgNotice) => notify(noticeTip(n)), [notify]);
  useImageNotices(src, onImgNotice);
  return async (text: string, files: readonly File[]): Promise<ImagesResult> => {
    let made = null as Made | null;
    let once: Promise<Made> | null = null;
    const note = async () => (made = await (once ??= l.add(text, true))).id;
    const left: File[] = [];
    for (const file of files) {
      const r = await src.insertImage(note, file);
      if (!r.ok) left.push(file);
      const tip = insertTip(r);
      if (tip) notify(tip);
    }
    const m = made;
    // 输入框本来没字、图一张都没写成：刚新建的空随手记撤销掉，不留空条
    const dropped = Boolean(m?.id && left.length === files.length && text.trim() === '');
    if (dropped && m?.id) void l.discard(m.id);
    else if (m?.id) setJust(m.id);
    if (m && m.id === null) report(m.result);
    rlog(`notes images n=${files.length} ok=${files.length - left.length} made=${m?.id ? 1 : 0} dropped=${dropped ? 1 : 0}`);
    return { ok: m?.id != null && !dropped, left };
  };
}

/** 输入行上待记下的图：选了先挂在这里，“×”去掉一张；预览用本机 blob: 地址，卸下时收回。
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

/** 编辑器插图区的状态（编辑页订一次，图列表和“图片”“拍照”共用；这一条的图只订一次）：上传器的提示全页共用，只认这一条随手记的图，
 *  电脑抽屉里的由随手记页出（不出两遍）。dropRef：附件区拖进来、粘贴进来的图片经它插入，插不进去时和点“图片”选的一样出提示 */
export function useEditorImages(noteId: string | null, drawer: boolean, dropRef?: MutableRefObject<((f: File) => void) | null>) {
  const [msg, setMsg] = useState<ImgMsg | null>(null);
  const src = useNoteSource();
  const im = src.useImages(noteId);
  const put = im.insert;
  /** 插一张，插不进去出提示；回插没插成（“重新插入”成了才删旧的那张） */
  const insert = useCallback(async (f: File): Promise<boolean> => {
    const r = await put(f);
    const tip = insertTip(r);
    if (tip) setMsg(tip);
    return r.ok;
  }, [put]);
  useEffect(() => {
    if (!dropRef) return undefined;
    dropRef.current = (f: File) => void insert(f);
    return () => {
      dropRef.current = null;
    };
  }, [dropRef, insert]);
  const onNotice = useCallback((n: ImgNotice) => {
    if (!drawer && n.noteId === noteId) setMsg(noticeTip(n));
  }, [drawer, noteId]);
  useImageNotices(src, onNotice);
  return { im, msg, insert, noteId };
}
export type EditorImgs = ReturnType<typeof useEditorImages>;

/** 编辑器里的“图片”“拍照”：手机整页放在底部工具条里（className 给按钮，带字）；电脑抽屉里是图下面一行 kit 胶囊（EditorImageList 的 picks） */
export function EditorPicks({ ed, disabled, className }: { ed: EditorImgs; disabled: boolean; className?: string | undefined }) {
  return <PickButtons onFile={ed.insert} disabled={disabled || ed.noteId === null} className={className} labeled idPrefix="note-edit" />;
}

/** 编辑器、抽屉里的插图提示 + 图（正文下面）；picks：图下面带一行“图片”“拍照”（电脑抽屉；手机整页的在底部工具条） */
export function EditorImageList({ ed, disabled, msgClass, picks }: { ed: EditorImgs; disabled: boolean; msgClass: string | undefined; picks: boolean }) {
  const t = useNotesT();
  const src = useNoteSource();
  const [view, setView] = useState<ViewOpen | null>(null);
  const { im } = ed;
  return (
    <>
      {ed.msg ? <ImgMsgLine className={msgClass} msg={ed.msg} /> : null}
      <div className={styles.box} data-testid="note-images">
        {im.items.length ? (
          <ul className={styles.list} aria-label={t('notes.img.list', {})}>
            {im.items.map(({ img, pending }, i) => (
              <OneImage key={img.id} img={img} n={i + 1} pending={pending} disabled={disabled} ai={src.caps.ai} onRemove={() => void im.remove(img.id)} onRetry={() => im.retry(img.id)} onReplace={ed.insert} onOpen={(from) => setView({ id: img.id, from })} />
            ))}
          </ul>
        ) : null}
        {picks ? (
          <div className={styles.picks}>
            <EditorPicks ed={ed} disabled={disabled} />
          </div>
        ) : null}
        {view ? <NoteImageView items={im.items} open={view} onClose={() => setView(null)} /> : null}
      </div>
    </>
  );
}

function OneImage(p: { img: NoteImage; n: number; pending: PendingImage | null; disabled: boolean; ai: boolean; onRemove(): void; onRetry(): boolean; onReplace(f: File): Promise<boolean>; onOpen(from: HTMLElement): void }) {
  const t = useNotesT();
  const src = useNoteSource().useImageSrc(p.img, false);
  const [busy, setBusy] = useState(false);
  const [replaceInput, replace] = useFilePick((f) => {
    setBusy(true);
    void p.onReplace(f).then((ok) => {
      setBusy(false);
      if (ok) p.onRemove();
    });
  }, 'one', `note-image-reinsert-input-${p.img.id}`);
  const bad = failKey(src);
  const failed = bad !== null;
  const uploading = p.pending !== null && p.pending.state !== 'failed';
  return (
    <li data-testid={`note-image-${p.img.id}`} data-state={failed ? 'failed' : uploading ? 'uploading' : 'done'}>
      <span className={styles.frame}>
        {src.url ? <BlobImg url={src.url} alt={t('notes.img.alt', {})} /> : null}
        {failed || uploading ? null : <button type="button" className={styles.open} onClick={(e) => p.onOpen(e.currentTarget)} aria-label={t('notes.img.view', { n: p.n })} data-testid={`note-image-open-${p.img.id}`} />}
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
              <Pressable type="button" className={`${chip.chip} ${chip.onGray}`} onClick={p.onRemove} disabled={p.disabled || busy} data-testid={`note-image-delete-${p.img.id}`}>
                {t('notes.img.delete', {})}
              </Pressable>
              <Pressable
                type="button"
                className={`${chip.chip} ${chip.onGray}`}
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
      {/* 识别状态：传好了才挂，懒加载 */}
      {failed || uploading || !p.ai ? null : <Suspense fallback={null}><ImageAiStatus id={p.img.id} /></Suspense>}
      {replaceInput}
    </li>
  );
}
