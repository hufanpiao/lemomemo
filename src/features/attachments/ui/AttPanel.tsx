// 附件区（B4b-1；定稿线框 sAtt、sPrev；架构 5.13 第 1～4、11、12 点）：普通随手记（NoteAttachments）、隐私记（VaultAttachments）共用这一块，
// 背后的动作由 src（data/att-source.ts 的 AttSource）给：普通的走 note_files + /files，隐私记的走 vault-file
// • 头一行“附件 N · 共 X MB”；每项：类型标记（PDF / W / X / P；电脑上有首页缩略图的换成缩略图）、文件名、
//   大小（PDF、PPT 写“· N 页”，Excel 写“· N 张表”）· 状态（准备上传 / 上传中 / 正在检查… / 没能加上）、“⋯”
// • 谁能加（R-114 D-3）：只有电脑布局（MQ_SIDEBAR，按窗口宽度、不按设备）显示“加附件”，能多选、拖进窗口、粘贴；
//   手机和窄窗口只写一句“文档请在电脑上加”。离线时“加附件”变灰，下面写“加附件需要联网”
// • 加附件时挂一个隐藏的预览沙箱（usePrep）抽页数、文字、首页缩略图，随文件一起传（5.13 第 2 点 ④）
// • 拖进来、粘贴进来的图片不进附件：交给 onImages（编辑器照插图处理并自己出失败提示，线框 DDRAG“图片照插图处理”）
// • “⋯”：电脑 预览 / 下载 / 删除；手机 预览 / 下载 / 用其他 App 打开（手机没有删除，线框 sAtt 第二张；浏览器分享不了文件时不出最后一项）。
//   只存不预览的（带宏、旧格式）没有“预览”，下面多一条说明带“下载”
// • 删除：软删，提示条“已删除”加“撤销”（不进“最近删除”，5.13 第 12 点）
// • 隐私记：加上后提示“已加到隐私记（加密存放）”带“撤销”（线框 sAtt 提示第七条）；下载后提示“下载后的文件不再加密”
// • 离线：看过的（本页内存里有）照常能预览，别的写“离线时打不开”（sPrev 第五张）
// • 预览浮层（PreviewLayer.tsx）单独懒加载：点了“预览”才下载
// • 运行日志：data/ 那一层各自记结果码，这里只记拖放、粘贴的个数，不记文件名
import { lazy, Suspense, useCallback, useState, type ReactNode } from 'react';
import { Popover } from '../../../kit/components/Popover.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { MQ_SIDEBAR, useMedia } from '../../../kit/hooks/useMedia.ts';
import { Pressable } from '../../../motion/components.ts';
import { useBlobSrc } from '../../../kit/hooks/useBlobSrc.ts';
import { DOC_TYPES } from '../../../../shared/manifests/attachments.ts';
import {
  canShareFiles,
  countOf,
  isMacro,
  markOf,
  previewOf,
  sizeText,
  useAttNotices,
  useAttT,
  useOnline,
  usePrep,
  useThumbUrl,
  type AddResult,
  type AttItem,
  type AttMsgKey,
  type AttNotice,
  type AttSource,
  type NoteFile,
  type PendingFile,
} from '../hooks/useNoteFiles.ts';
import { AddButton, DropVeil, useDropAndPaste } from './AttDrop.tsx';
import styles from './AttPanel.module.css';

const PreviewLayer = lazy(() => import('./PreviewLayer.tsx'));

export interface AttPanelProps {
  src: AttSource;
  items: readonly AttItem[];
  noteId: string | null;
  /** 只读行、已删除：不能加、不能删 */
  disabled: boolean;
  /** 拖进来、粘贴进来的图片（照插图处理；隐私记没有，图片照样不进附件） */
  onImages?(files: File[]): void;
}

type Msg = { key: AttMsgKey; name: string };
/** 提示条：删了能撤销（撤销调 undoRemove）；隐私记加上了能撤销（撤销调 remove） */
type Undo = { id: string; name: string; added: boolean };

const isImage = (f: File): boolean => f.type.startsWith('image/');

/** 提示文案：有的带“{name}”有的不带，统一传 name（模板里没有的参数不用）；按键逐个写类型太啰嗦，这里收一下类型 */
const msgText = (t: ReturnType<typeof useAttT>, m: Msg): string => (t as (k: AttMsgKey, p: { name: string }) => string)(m.key, { name: m.name });

export function AttPanel({ src, items, noteId, disabled, onImages }: AttPanelProps) {
  const t = useAttT();
  const vault = src.scope === 'vault';
  const desk = useMedia(MQ_SIDEBAR);
  const online = useOnline();
  const [msg, setMsg] = useState<Msg | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [preview, setPreview] = useState<NoteFile | null>(null);
  const canAdd = desk && !disabled && noteId !== null;
  const prep = usePrep(canAdd);

  const onNotice = useCallback((n: AttNotice) => {
    if (n.noteId === noteId) setMsg({ key: `att.fail.${n.key}`, name: n.name });
  }, [noteId]);
  useAttNotices(src, onNotice);

  const add = useCallback(
    async (files: readonly File[]) => {
      if (noteId === null) return;
      setMsg(null);
      const pics = files.filter(isImage);
      if (pics.length && onImages) onImages(pics);
      for (const f of files.filter((x) => !isImage(x))) {
        const r: AddResult = await src.add(noteId, f, prep.extract);
        // 别的失败上传器自己发提示（useAttNotices 收）；隐私记、只读这两种它不发
        if (!r.ok && (r.key === 'private' || r.key === 'readonly')) setMsg({ key: `att.fail.${r.key}`, name: f.name });
        else if (r.ok && vault) setUndo({ id: r.id, name: f.name, added: true });
      }
    },
    [noteId, onImages, src, prep.extract, vault],
  );

  const drag = useDropAndPaste(canAdd && online, add);

  // 旧提示在下一次操作开始时清掉（整块评审第 16 条），不另起计时
  const open = (f: NoteFile): void => {
    setMsg(null);
    if (!online && !src.inMemory(f.id)) return setMsg({ key: 'att.open.offline', name: f.name });
    setPreview(f);
  };
  const save = async (f: NoteFile): Promise<void> => {
    setMsg(null);
    const r = await src.download(f);
    if (!r.ok) setMsg({ key: `att.open.${r.why}`, name: f.name });
    else if (vault && (r.outcome === 'downloaded' || r.outcome === 'shared')) setMsg({ key: 'att.vault.plain', name: f.name });
  };
  const share = async (f: NoteFile): Promise<void> => {
    setMsg(null);
    if (!online && !src.inMemory(f.id)) return setMsg({ key: 'att.open.offline', name: f.name });
    const r = await src.share(f);
    if (!r.ok) return setMsg({ key: `att.open.${r.why}`, name: f.name });
    // 取字节等太久，点击带来的用户激活过期了：字节已在本页内存，再点一次就能分享
    if (r.outcome === 'needs_tap') setMsg({ key: 'att.share.again', name: f.name });
    else if (r.outcome === 'unsupported') setMsg({ key: 'att.share.no', name: f.name });
  };
  const remove = async (id: string, name: string): Promise<void> => {
    // 只有软删的才给“撤销”；行没写成被放弃的、本来就没了的，删掉就是删掉
    setMsg(null);
    const r = await src.remove(id);
    if (r === 'soft') setUndo({ id, name, added: false });
    else if (r === false) setMsg({ key: 'att.fail.write', name });
  };

  const total = items.reduce((n, it) => n + (it.file?.bytes ?? it.pending?.bytes ?? 0), 0);
  const anyFile = items.some((it) => it.file);
  return (
    <section className={styles.box} aria-label={t('att.list', {})} data-testid="note-files">
      {msg ? (
        <p className={styles.msg} role="alert" data-testid="note-files-msg">
          {msgText(t, msg)}
        </p>
      ) : null}
      {items.length ? (
        <>
          <div className={styles.head}>
            <b>{t('att.head', { n: items.length })}</b>
            <span>{t('att.total', { s: sizeText(total) })}</span>
          </div>
          <ul className={styles.list}>
            {items.map((it) => (
              <AttRow
                key={it.id}
                it={it}
                desk={desk}
                online={online}
                disabled={disabled}
                src={src}
                onPreview={open}
                onDownload={(f) => void save(f)}
                onShare={(f) => void share(f)}
                onRemove={(id, name) => void remove(id, name)}
              />
            ))}
          </ul>
        </>
      ) : null}
      {!online && anyFile ? <p className={styles.note}>{t('att.offlineNote', {})}</p> : null}
      {desk ? (
        <AddButton disabled={!canAdd || !online} offline={!online && canAdd} onFiles={(f) => void add(f)} />
      ) : (
        <p className={styles.note} data-testid="note-files-phone">
          {t('att.phoneOnly', {})}
        </p>
      )}
      {drag > 0 ? <DropVeil n={drag} vault={vault} /> : null}
      {/* 抽预览材料的隐藏沙箱：没有来源、看不见、不进读屏（hidden 也能跑，prep 画缩略图用 intent:'print'） */}
      {canAdd ? <iframe ref={prep.ref} hidden src="/app/preview" sandbox="allow-scripts" title={t('att.pv.frame', {})} data-testid="note-files-prep" /> : null}
      {undo ? (
        <UndoToast
          key={undo.id}
          message={undo.added ? t('att.vault.added', {}) : t('att.deleted', { name: undo.name })}
          undoLabel={t('att.undo', {})}
          onUndo={() => void (undo.added ? src.remove(undo.id) : src.undoRemove(undo.id))}
          onClose={() => setUndo(null)}
          data-testid="note-files-undo"
        />
      ) : null}
      {preview ? (
        <Suspense fallback={null}>
          <PreviewLayer
            src={src}
            file={preview}
            desk={desk}
            onClose={() => setPreview(null)}
            onDownload={() => void save(preview)}
            onShare={() => void share(preview)}
            onFail={(key) => setMsg({ key, name: preview.name })}
          />
        </Suspense>
      ) : null}
    </section>
  );
}

/** 状态那一行的字：上传中、正在检查、没能加上；正常的写大小（只存不预览的加“只能下载”） */
function subText(it: AttItem, t: ReturnType<typeof useAttT>, online: boolean, src: AttSource): string {
  const p: PendingFile | null = it.pending;
  const size = sizeText(it.file?.bytes ?? p?.bytes ?? 0);
  if (p) return `${t(p.state === 'failed' ? 'att.st.failed' : p.state === 'writing' ? 'att.st.writing' : p.state === 'uploading' ? 'att.st.uploading' : 'att.st.checking', {})} · ${size}`;
  const f = it.file;
  if (!f) return size;
  if (f.check === 'rejected') return `${t('att.st.failed', {})} · ${size}`;
  if (f.check === 'pending') return t('att.st.checking', {});
  if (previewOf(f.kind) === null) return `${size} · ${t('att.onlyDl', {})}`;
  if (!online && !src.inMemory(f.id)) return t('att.offline', {});
  const c = countOf(f.kind);
  return c === null || f.pages === null ? size : `${size} · ${t(c === 'pages' ? 'att.pages' : 'att.sheets', { n: f.pages })}`;
}

function AttRow(p: {
  it: AttItem;
  src: AttSource;
  desk: boolean;
  online: boolean;
  disabled: boolean;
  onPreview(f: NoteFile): void;
  onDownload(f: NoteFile): void;
  onShare(f: NoteFile): void;
  onRemove(id: string, name: string): void;
}) {
  const t = useAttT();
  const [menu, setMenu] = useState(false);
  const { it } = p;
  const f = it.file;
  const kind = f?.kind ?? it.pending?.kind ?? 'pdf';
  const thumb = useThumbUrl(p.src, f, p.desk);
  const name = f?.name ?? it.pending?.name ?? '';
  const failed = it.pending?.state === 'failed' || f?.check === 'rejected';
  const busy = !failed && (it.pending !== null || f?.check === 'pending');
  const ready = f !== null && f.check === 'ok' && !busy;
  const way = previewOf(kind);
  const item = (label: string, fn: () => void, testId: string): ReactNode => (
    <Pressable
      className={styles.menuItem}
      onClick={() => {
        setMenu(false);
        fn();
      }}
      data-testid={testId}
    >
      {label}
    </Pressable>
  );
  return (
    <li className={styles.row} data-testid={`note-file-${it.id}`} data-state={failed ? 'failed' : busy ? 'busy' : 'ok'}>
      <div className={styles.line}>
        {thumb ? (
          <Thumb url={thumb} />
        ) : (
          <span className={styles.mark} aria-hidden="true">
            {markOf(kind)}
          </span>
        )}
        <span className={styles.tx}>
          <b className={styles.name}>{name}</b>
          <small className={failed ? styles.subBad : styles.sub}>{subText(it, t, p.online, p.src)}</small>
          {busy && it.pending ? <span className={styles.bar} data-stage={it.pending.state} aria-hidden="true" /> : null}
        </span>
        {failed ? (
          <span className={styles.failBtns}>
            {it.pending && attRetryable(it.pending) ? (
              <Pressable className={styles.btnS} onClick={() => p.src.retry(it.id)} disabled={p.disabled} data-testid={`note-file-retry-${it.id}`}>
                {t('att.st.retry', {})}
              </Pressable>
            ) : null}
            {p.desk ? (
              <Pressable className={styles.btnS} onClick={() => p.onRemove(it.id, name)} disabled={p.disabled} data-testid={`note-file-drop-${it.id}`}>
                {t('att.st.drop', {})}
              </Pressable>
            ) : null}
          </span>
        ) : (
          <Popover
            open={menu}
            onOpenChange={setMenu}
            label={t('att.more', { name })}
            data-testid={`note-file-menu-${it.id}`}
            align="end"
            className={styles.menu}
            trigger={
              <button type="button" className={styles.more} aria-label={t('att.more', { name })} disabled={!ready && !(p.desk && !p.disabled)} data-testid={`note-file-more-${it.id}`}>
                ⋯
              </button>
            }
          >
            {ready && way !== null ? item(t('att.preview', {}), () => p.onPreview(f), `note-file-preview-${it.id}`) : null}
            {ready ? item(t('att.download', {}), () => p.onDownload(f), `note-file-download-${it.id}`) : null}
            {ready && !p.desk && canShareFiles(undefined, DOC_TYPES[kind]) ? item(t('att.openWith', {}), () => p.onShare(f), `note-file-share-${it.id}`) : null}
            {p.desk && !p.disabled ? item(t('att.delete', {}), () => p.onRemove(it.id, name), `note-file-delete-${it.id}`) : null}
          </Popover>
        )}
      </div>
      {ready && way === null ? (
        <p className={styles.only}>
          {t(isMacro(kind) ? 'att.macro' : 'att.legacy', {})}
          <Pressable className={styles.btnS} onClick={() => p.onDownload(f)} data-testid={`note-file-only-dl-${it.id}`}>
            {t('att.download', {})}
          </Pressable>
        </p>
      ) : null}
    </li>
  );
}

/** 电脑上的首页缩略图（占类型标记的位置；图本身不念，文件名就在旁边） */
function Thumb({ url }: { url: string }) {
  const ref = useBlobSrc(url);
  return <img ref={ref} className={styles.thumb} alt="" data-testid="note-file-thumb" />;
}

/** 上传器只能重传“行已确认、文件没传上”的（网络类）；别的让用户去掉后重新加 */
const attRetryable = (p: PendingFile): boolean => p.fail === 'retry';

