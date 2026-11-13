// 附件功能的 hooks：词典、一条随手记的附件（集合里的行 + 上传器里待传的状态）、在线状态、上传提示
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { filesByNote, type NoteFile, type Row } from '../data/attach-list.ts';
import { attUploader, TABLE, type AttNotice, type PendingFile } from '../data/attach-uploader.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

// 界面只经 hooks 用 data（分层规矩）：界面要的纯函数和动作从这里转出
export { isMacro, markOf, previewOf, sizeText } from '../data/attach-kinds.ts';
export type { NoteFile } from '../data/attach-list.ts';
export { download, inMemory, msViewerUrl, openBytes } from '../data/attach-open.ts';
export { attUploader, type AddResult, type AttNotice, type PendingFile } from '../data/attach-uploader.ts';
export { readMsPref, writeMsPref } from '../data/ms-pref.ts';

export type AttMsgKey = keyof typeof zh & string;
export const useAttT = makeUseT({ zh, ko });

/** 列表上的一项：服务器上有行的（file），或还没写成行就失败了的（只有 pending） */
export type AttItem = { id: string; file: NoteFile | null; pending: PendingFile | null };

const usePending = (): readonly PendingFile[] => {
  const u = attUploader();
  return useSyncExternalStore(u.subscribe, u.getSnapshot, u.getSnapshot);
};

/** 这条随手记的附件：行按加入先后，每项带上传状态；本页刚失败、行已被丢掉的排在最后 */
export function useNoteFiles(noteId: string | null): AttItem[] {
  const rows = useCollection<Row>(TABLE);
  const pending = usePending();
  return useMemo(() => {
    if (noteId === null) return [];
    const files = filesByNote(rows).get(noteId) ?? [];
    const mine = pending.filter((p) => p.noteId === noteId);
    const items: AttItem[] = files.map((f) => ({ id: f.id, file: f, pending: mine.find((p) => p.id === f.id) ?? null }));
    for (const p of mine) if (!files.some((f) => f.id === p.id)) items.push({ id: p.id, file: null, pending: p });
    return items;
  }, [rows, pending, noteId]);
}

const subOnline = (fn: () => void): (() => void) => {
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => {
    window.removeEventListener('online', fn);
    window.removeEventListener('offline', fn);
  };
};
/** navigator.onLine 明说断网才算离线（没有这个属性的环境当在线） */
export const useOnline = (): boolean => useSyncExternalStore(subOnline, () => navigator.onLine !== false, () => true);

/** 上传器的提示（本机判不过、写行被拒、传不上、file-check 没收） */
export function useAttNotices(fn: (n: AttNotice) => void): void {
  useEffect(() => attUploader().onNotice(fn), [fn]);
}
