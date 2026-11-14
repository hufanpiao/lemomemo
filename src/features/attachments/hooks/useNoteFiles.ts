// 附件功能的 hooks：词典、一条随手记的附件（集合里的行 + 上传器里待传的状态）、隐私记附件（vault-att 的快照）、
// 加附件时抽预览材料的隐藏沙箱（usePrep）、电脑上列表的缩略图地址、在线状态、上传提示
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import { makeUseT } from '../../../kit/hooks/useT.ts';
import { filesByNote, type NoteFile, type Row } from '../data/attach-list.ts';
import type { AttSource } from '../data/att-source.ts';
import { attUploader, TABLE, type AttNotice, type PendingFile } from '../data/attach-uploader.ts';
import { createPrepClient } from '../data/prep-client.ts';
import type { VaultAtt } from '../data/vault-att.ts';
import { ko } from '../i18n/ko.ts';
import { zh } from '../i18n/zh.ts';

// 界面只经 hooks 用 data（分层规矩）：界面要的纯函数和动作从这里转出
export { countOf, isMacro, markOf, previewOf, sizeText } from '../data/attach-kinds.ts';
export type { NoteFile } from '../data/attach-list.ts';
export { noteSource, type AttSource } from '../data/att-source.ts';
export type { AddResult, AttNotice, Extract, PendingFile } from '../data/attach-uploader.ts';
export { createVaultAtt, type VaultAtt, type VaultFileApi } from '../data/vault-att.ts';
export { readMsPref, writeMsPref, type MsScope } from '../../../core/ms-pref.ts';
export { canShareFiles } from '../../../platform/save-file.ts';

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

/** 隐私记这条的附件（vault-att 的快照，形状同 useNoteFiles） */
export function useVaultFiles(va: VaultAtt): { loaded: boolean; items: AttItem[] } {
  const snap = useSyncExternalStore(va.subscribe, va.get, va.get);
  return useMemo(() => {
    const items: AttItem[] = snap.files.map((f) => ({ id: f.id, file: f, pending: null }));
    for (const p of snap.pending) items.push({ id: p.id, file: null, pending: p });
    return { loaded: snap.loaded, items };
  }, [snap]);
}

export { useOnline } from '../../../kit/hooks/useOnline.ts';

/** 上传器的提示（本机判不过、写行被拒、传不上、file-check 没收） */
export function useAttNotices(src: AttSource, fn: (n: AttNotice) => void): void {
  useEffect(() => src.onNotice(fn), [src, fn]);
}

/** 加附件时抽预览材料：on 为 true 时挂一个隐藏的预览沙箱，回 iframe 的 ref 和 extract（交给 src.add） */
export function usePrep(on: boolean) {
  const ref = useRef<HTMLIFrameElement>(null);
  const client = useMemo(() => createPrepClient(() => ref.current?.contentWindow ?? null), []);
  useEffect(() => {
    if (!on) return undefined;
    window.addEventListener('message', client.onMessage);
    return () => window.removeEventListener('message', client.onMessage);
  }, [on, client]);
  return { ref, extract: client.extract };
}

/** 电脑上列表的首页缩略图：取到了回 blob: 地址，换了文件、卸下时撤销；on 为 false（手机、没有缩略图）回 '' */
export function useThumbUrl(src: AttSource, f: NoteFile | null, on: boolean): string {
  const [url, setUrl] = useState('');
  const id = f?.id ?? null;
  const want = on && f !== null && f.hasThumb && f.check === 'ok';
  useEffect(() => {
    if (!want || f === null) return undefined;
    let alive = true;
    let made = '';
    void src.thumb(f).then((b) => {
      if (!alive || !b) return;
      made = URL.createObjectURL(b);
      setUrl(made);
    });
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
      setUrl('');
    };
    // 只随这个文件、开关变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, id, want]);
  return url;
}
