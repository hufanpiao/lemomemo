// 随手记插图：写行、上传、失败处理（B4 S3；任务单第 67 行；架构 0.23、0.33；主持人定的 4 件事）
// • 先写行再传：note_images 一行（path = <uid>/<note_id>/<id>.webp，bytes = 原图字节数，has_thumb = true）经 write.insert 进 outbox，
//   deps 指向这条随手记（随手记先上服务器）。行写不进去（本机库、校验）就不传、提示出错
// • 等这一行确认（outbox 里这一条的项都没了、集合里还有这一行）再依次 PUT 原图和 .t.webp（platform/files.ts，经 /files，页面不绕开）
// • 待传的图只放内存（主持人定 1）：页面关了图就没了，行上显示“图片没传上”（取字节 not_found），给“删除”“重新插入”
// • 行写进 outbox 后被服务器拒（error 事件：quota_exceeded 等，主持人定 2）：这一项留在“发送失败”区（R-378 的 FailedCreateActions，
//   note_images 只给“放弃”，outbox-logic.ts 的 NO_COPY_TABLES），同时这里发一条提示；超限的提示带“最近删除”入口（界面做）
// • 上传的拒绝：403 forbidden 带 reason quota_exceeded / length_mismatch / length_required、411 length_required、413、415、426 各有一条提示；
//   网络、5xx、限流按 2 s、5 s、15 s 退避重试三次，还不行按“没传上”；account 类（停用、会话被吊销）走 accountExitOf → 离开本机（S13）
// • 删除：发送失败区里还有这一行的新建 → 放弃（resolveFailedCreate drop）；否则软删（deleted_at），进“最近删除”
// 纯 TS：不准 import React（A1）
import { PUT_BACKOFF, putFailOf, putParts } from '../../../core/row-sync.ts';
import type { FileError, UploadResult } from '../../../platform/files.ts';
import { noteImagePath } from '../../../../shared/logic/files/media-path.ts';

/** 插图失败的几种提示（i18n 键 notes.img.fail.<键>） */
export type ImgFailKey = 'quota' | 'length' | 'too_big' | 'bad_type' | 'upgrade' | 'denied' | 'retry' | 'write';

export { uuidv7, type QueueItem, type RowSync } from '../../../core/row-sync.ts';

/** 原图路径（库里 check 钉死的拼法；和 ai-media 读图共用 shared 的一份） */
export const imagePath = noteImagePath;
/** 缩略图路径：同名 .t.webp */
export const thumbPath = (path: string): string => path.replace(/\.webp$/, '.t.webp');

export interface ImageMeta {
  bytes: number;
  width: number;
  height: number;
  takenAt: number | null;
}

/** note_images 的新建整行（只放客户端能写的列） */
export function imageRow(userId: string, noteId: string, id: string, m: ImageMeta): Record<string, unknown> & { id: string } {
  return {
    id,
    note_id: noteId,
    bucket: 'images',
    path: imagePath(userId, noteId, id),
    bytes: m.bytes,
    width: m.width,
    height: m.height,
    mime: 'image/webp',
    taken_at: m.takenAt,
    has_thumb: true,
  };
}

/** 上传的错误 → 提示；null = 可以退避重试（分类在 core/row-sync.ts，插图的提示键和分类同名） */
export const uploadFailKey = (e: FileError): ImgFailKey | null => putFailOf(e);

/** 行写进 outbox 后被服务器拒的码 → 提示 */
export const writeFailKey = (code: string | null): ImgFailKey => (code === 'quota_exceeded' ? 'quota' : 'write');


/** 上传原图和缩略图；退避重试 retry 类的错误；返回 'ok'、提示键，或 account 类错误（交给调用方离开本机） */
export async function uploadPair(
  up: (path: string, blob: Blob) => Promise<UploadResult>,
  path: string,
  full: Blob,
  thumb: Blob,
  sleep: (ms: number) => Promise<void>,
  backoff: readonly number[] = PUT_BACKOFF,
): Promise<'ok' | ImgFailKey | FileError> {
  return putParts<readonly [string, Blob], ImgFailKey>([[path, full], [thumbPath(path), thumb]], ([p, b]) => up(p, b), uploadFailKey, 'retry', sleep, backoff);
}
