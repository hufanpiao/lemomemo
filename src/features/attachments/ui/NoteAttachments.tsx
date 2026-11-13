// 随手记里的附件区（B4b-1；定稿线框 sAtt、sPrev；架构 5.13 第 1～4、12 点）：编辑器、电脑抽屉里插图区下面
// • 头一行“附件 N · 共 X MB”；每项：类型标记（PDF / W / X / P）、文件名、大小 · 状态（准备上传 / 上传中 / 正在检查… / 没能加上）、“⋯”
// • 谁能加（R-114 D-3）：只有电脑布局（MQ_SIDEBAR，按窗口宽度、不按设备）显示“加附件”，能多选、拖进窗口、粘贴；
//   手机和窄窗口只写一句“文档请在电脑上加”。离线时“加附件”变灰，下面写“加附件需要联网”
// • 拖进来、粘贴进来的图片不进附件：交给 onImages（编辑器照插图处理，线框 DDRAG“图片照插图处理”）
// • “⋯”：电脑 预览 / 下载 / 删除；手机 预览 / 下载（手机没有删除，线框 sAtt 第二张）。只存不预览的（带宏、旧格式）没有“预览”，下面多一条说明带“下载”
// • 删除：软删，提示条“已删除”加“撤销”（不进“最近删除”，5.13 第 12 点）
// • 离线：看过的（本页内存里有）照常能预览，别的写“离线时打不开”（sPrev 第五张）
// • 预览浮层（PreviewLayer.tsx）单独懒加载：点了“预览”才下载
// • 运行日志：上传器、打开下载那一层各自记结果码（data/），这里不记文件名
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Popover } from '../../../kit/components/Popover.tsx';
import { UndoToast } from '../../../kit/components/UndoToast.tsx';
import { MQ_SIDEBAR, useMedia } from '../../../kit/hooks/useMedia.ts';
import { Pressable } from '../../../motion/components.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import {
  attUploader,
  download,
  inMemory,
  isMacro,
  markOf,
  previewOf,
  sizeText,
  useAttNotices,
  useAttT,
  useNoteFiles,
  useOnline,
  type AddResult,
  type AttItem,
  type AttMsgKey,
  type AttNotice,
  type NoteFile,
  type PendingFile,
} from '../hooks/useNoteFiles.ts';
import styles from './NoteAttachments.module.css';

const PreviewLayer = lazy(() => import('./PreviewLayer.tsx'));

/** 选文件框收的类型（10 种文档的扩展名；真正的类型由本机按内容判） */
const ACCEPT = '.pdf,.docx,.xlsx,.pptx,.docm,.xlsm,.pptm,.doc,.xls,.ppt';

export interface NoteAttachmentsProps {
  noteId: string | null;
  /** 只读行、已删除：不能加、不能删 */
  disabled: boolean;
  /** 拖进来、粘贴进来的图片（照插图处理） */
  onImages?(files: File[]): void;
}

type Msg = { key: AttMsgKey; name: string };
type Undo = { id: string; name: string };

const isImage = (f: File): boolean => f.type.startsWith('image/');

/** 提示文案：有的带“{name}”有的不带，统一传 name（模板里没有的参数不用）；按键逐个写类型太啰嗦，这里收一下类型 */
const msgText = (t: ReturnType<typeof useAttT>, m: Msg): string => (t as (k: AttMsgKey, p: { name: string }) => string)(m.key, { name: m.name });

export default function NoteAttachments({ noteId, disabled, onImages }: NoteAttachmentsProps) {
  const t = useAttT();
  const items = useNoteFiles(noteId);
  const desk = useMedia(MQ_SIDEBAR);
  const online = useOnline();
  const [msg, setMsg] = useState<Msg | null>(null);
  const [undo, setUndo] = useState<Undo | null>(null);
  const [preview, setPreview] = useState<NoteFile | null>(null);
  const canAdd = desk && !disabled && noteId !== null;

  const onNotice = useCallback((n: AttNotice) => {
    if (n.noteId === noteId) setMsg({ key: `att.fail.${n.key}`, name: n.name });
  }, [noteId]);
  useAttNotices(onNotice);

  const add = useCallback(
    async (files: readonly File[]) => {
      if (noteId === null) return;
      const pics = files.filter(isImage);
      if (pics.length && onImages) onImages(pics);
      for (const f of files.filter((x) => !isImage(x))) {
        const r: AddResult = await attUploader().add(noteId, f);
        if (!r.ok && r.key !== 'silent') setMsg({ key: `att.fail.${r.key}`, name: f.name });
      }
    },
    [noteId, onImages],
  );

  const drag = useDropAndPaste(canAdd && online, add);

  const open = (f: NoteFile): void => {
    if (!online && !inMemory(f.id)) return setMsg({ key: 'att.open.offline', name: f.name });
    setPreview(f);
  };
  const save = async (f: NoteFile): Promise<void> => {
    const r = await download(f);
    if (!r.ok) setMsg({ key: `att.open.${r.why}`, name: f.name });
  };
  const remove = async (id: string, name: string): Promise<void> => {
    if (await attUploader().remove(id)) setUndo({ id, name });
    else setMsg({ key: 'att.fail.write', name });
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
                onPreview={open}
                onDownload={(f) => void save(f)}
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
      {drag > 0 ? <DropVeil n={drag} /> : null}
      {undo ? (
        <UndoToast
          key={undo.id}
          message={t('att.deleted', { name: undo.name })}
          undoLabel={t('att.undo', {})}
          onUndo={() => void attUploader().undoRemove(undo.id)}
          onClose={() => setUndo(null)}
          data-testid="note-files-undo"
        />
      ) : null}
      {preview ? (
        <Suspense fallback={null}>
          <PreviewLayer file={preview} desk={desk} onClose={() => setPreview(null)} onDownload={() => void save(preview)} onFail={(key) => setMsg({ key, name: preview.name })} />
        </Suspense>
      ) : null}
    </section>
  );
}

/** 状态那一行的字：上传中、正在检查、没能加上；正常的写大小（只存不预览的加“只能下载”） */
function subText(it: AttItem, t: ReturnType<typeof useAttT>, online: boolean): string {
  const p: PendingFile | null = it.pending;
  const size = sizeText(it.file?.bytes ?? p?.bytes ?? 0);
  if (p) return `${t(p.state === 'failed' ? 'att.st.failed' : p.state === 'writing' ? 'att.st.writing' : p.state === 'uploading' ? 'att.st.uploading' : 'att.st.checking', {})} · ${size}`;
  const f = it.file;
  if (!f) return size;
  if (f.check === 'rejected') return `${t('att.st.failed', {})} · ${size}`;
  if (f.check === 'pending') return t('att.st.checking', {});
  if (previewOf(f.kind) === null) return `${size} · ${t('att.onlyDl', {})}`;
  if (!online && !inMemory(f.id)) return t('att.offline', {});
  return size;
}

function AttRow(p: { it: AttItem; desk: boolean; online: boolean; disabled: boolean; onPreview(f: NoteFile): void; onDownload(f: NoteFile): void; onRemove(id: string, name: string): void }) {
  const t = useAttT();
  const [menu, setMenu] = useState(false);
  const { it } = p;
  const f = it.file;
  const kind = f?.kind ?? it.pending?.kind ?? 'pdf';
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
        <span className={styles.mark} aria-hidden="true">
          {markOf(kind)}
        </span>
        <span className={styles.tx}>
          <b className={styles.name}>{name}</b>
          <small className={failed ? styles.subBad : styles.sub}>{subText(it, t, p.online)}</small>
          {busy && it.pending ? <span className={styles.bar} data-stage={it.pending.state} aria-hidden="true" /> : null}
        </span>
        {failed ? (
          <span className={styles.failBtns}>
            {it.pending && attRetryable(it.pending) ? (
              <Pressable className={styles.btnS} onClick={() => attUploader().retry(it.id)} disabled={p.disabled} data-testid={`note-file-retry-${it.id}`}>
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

/** 上传器只能重传“行已确认、文件没传上”的（网络类）；别的让用户去掉后重新加 */
const attRetryable = (p: PendingFile): boolean => p.fail === 'retry';

/** “加附件”：多选；离线时变灰，下面写一句 */
function AddButton({ disabled, offline, onFiles }: { disabled: boolean; offline: boolean; onFiles(f: File[]): void }) {
  const t = useAttT();
  const ref = useRef<HTMLInputElement>(null);
  return (
    <div className={styles.add}>
      <Pressable type="button" className={styles.pick} onClick={() => ref.current?.click()} disabled={disabled} data-testid="note-files-add">
        {t('att.add', {})}
      </Pressable>
      {offline ? (
        <span className={styles.addOff} data-testid="note-files-offline">
          {t('att.addOffline', {})}
        </span>
      ) : null}
      <input
        ref={ref}
        type="file"
        multiple
        accept={ACCEPT}
        hidden
        tabIndex={-1}
        onChange={(e) => {
          const fs = [...(e.target.files ?? [])];
          e.target.value = '';
          if (fs.length) onFiles(fs);
        }}
        data-testid="note-files-input"
      />
    </div>
  );
}

/** 拖进窗口时盖一层“松手就加到这条随手记”（线框 DDRAG） */
function DropVeil({ n }: { n: number }) {
  const t = useAttT();
  return (
    <div className={styles.veil} data-testid="note-files-drop">
      <div className={styles.veilBox}>
        <div className={styles.veilPlus} aria-hidden="true">
          ＋
        </div>
        <div className={styles.veilTitle}>{t('att.drop.title', {})}</div>
        <div className={styles.veilSub}>{t('att.drop.sub', { n })}</div>
        <div className={styles.veilHint}>{t('att.drop.hint', {})}</div>
      </div>
    </div>
  );
}

const hasFiles = (d: DataTransfer | null): boolean => d !== null && [...d.types].includes('Files');

/** 拖文件进窗口、Ctrl+V 粘贴文件（on 为 false 时不接）：回拖着的文件个数（0 = 没在拖） */
function useDropAndPaste(on: boolean, add: (f: File[]) => Promise<void>): number {
  const [n, setN] = useState(0);
  const depth = useRef(0);
  useEffect(() => {
    if (!on) {
      setN(0);
      return undefined;
    }
    const enter = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth.current += 1;
      setN(e.dataTransfer?.items.length ?? 1);
    };
    const over = (e: DragEvent): void => {
      if (hasFiles(e.dataTransfer)) e.preventDefault();
    };
    const leave = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setN(0);
    };
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth.current = 0;
      setN(0);
      const fs = [...(e.dataTransfer?.files ?? [])];
      rlog(`att drop n=${fs.length}`);
      if (fs.length) void add(fs);
    };
    const paste = (e: ClipboardEvent): void => {
      const fs = [...(e.clipboardData?.files ?? [])];
      if (!fs.length) return;
      e.preventDefault();
      rlog(`att paste n=${fs.length}`);
      void add(fs);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', over);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    window.addEventListener('paste', paste);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', over);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
      window.removeEventListener('paste', paste);
      depth.current = 0;
    };
  }, [on, add]);
  return n;
}
