// 附件区背后的一套动作（B4b-1）：普通随手记（note_files 行 + /files）和隐私记（vault-file 函数）各给一份，附件区、预览浮层只认这个接口
// • 普通的：上传器（attach-uploader.ts，先写行再 PUT）、取字节下载分享（attach-open.ts，签名 + sha256）
// • 隐私记的：data/vault-att.ts（multipart 上传、解密后回字节、ms_preview 临时明文副本）
// 纯 TS：不准 import React（A1）
import type { MsScope } from '../../../core/ms-pref.ts';
import type { NoteFile } from './attach-list.ts';
import { download, inMemory, msViewerUrl, openBytes, share, thumbBlob, type DownloadResult, type OpenResult, type ShareResult } from './attach-open.ts';
import { attUploader, type AddResult, type AttNotice, type Extract, type RemoveResult } from './attach-uploader.ts';

export interface AttSource {
  /** PPT 交不交给微软记在哪一份（隐私记另问，问的卡多一句“会先解密”） */
  readonly scope: MsScope;
  add(noteId: string, file: File, extract?: Extract): Promise<AddResult>;
  remove(id: string): Promise<RemoveResult>;
  undoRemove(id: string): Promise<boolean>;
  /** 再传一次（只有网络类失败能重传）；不能重传回 false */
  retry(id: string): boolean;
  /** 取明文字节（只许读；要转移的自己 slice） */
  open(f: NoteFile): Promise<OpenResult>;
  download(f: NoteFile): Promise<DownloadResult>;
  /** 用其他 App 打开（系统分享面板） */
  share(f: NoteFile): Promise<ShareResult>;
  /** 交给微软的 embed 地址；拿不到回 null（预览浮层退回本机“缩略图 + 每页文字”） */
  msUrl(f: NoteFile): Promise<string | null>;
  /** 关掉微软预览：隐私记要立刻删临时明文副本；普通的签名链接几分钟自己过期，什么都不做 */
  msEnd(): void;
  /** 这次打开 App 后取过的（离线时还能看） */
  inMemory(id: string): boolean;
  /** 首页缩略图（webp）；没有就 null */
  thumb(f: NoteFile): Promise<Blob | null>;
  onNotice(fn: (n: AttNotice) => void): () => void;
}

/** 普通随手记的那一份 */
export const noteSource: AttSource = {
  scope: 'note',
  add: (noteId, file, extract) => attUploader().add(noteId, file, extract),
  remove: (id) => attUploader().remove(id),
  undoRemove: (id) => attUploader().undoRemove(id),
  retry: (id) => attUploader().retry(id),
  open: openBytes,
  download,
  share,
  msUrl: msViewerUrl,
  msEnd: () => undefined,
  inMemory,
  thumb: (f) => (f.hasThumb ? thumbBlob(f) : Promise.resolve(null)),
  onNotice: (fn) => attUploader().onNotice(fn),
};
