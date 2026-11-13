// 加附件前在本机先判一遍（架构 5.13 第 2 点 ①②③⑤）：大小 ≤ 10 MB、按内容判类型（shared/logic/files/file-sniff.ts，和服务器 file-check 同一份）、
// ZIP 家族按真实解压字节数查炸弹（zipBombCheck）、算整个文件的 sha256、清理文件名（扩展名按判出的类型重写）。元数据原样保存（D-5），不改字节。
// 代定（B4b-1）：这一步在主页面跑、不进预览沙箱的 Worker——这里只有我们自己的判型代码（服务器同跑），解压用浏览器原生的
//   DecompressionStream（异步、不占主线程），第三方解析库（pdf.js、docx-preview、SheetJS）仍只在预览沙箱里。
//   首页缩略图和抽文字（第 2 点 ④）是 B4b-2 识图、按意思找的输入，这一批不做：has_thumb 一律 false、text_excerpt 为空。
// 纯 TS：不准 import React（A1）
import { DOC_TYPES, type DocKind } from '../../../../shared/manifests/attachments.ts';
import { sanitizeFileName } from '../../../../shared/logic/files/file-name.ts';
import { sniffFile, zipBombCheck } from '../../../../shared/logic/files/file-sniff.ts';
import { inflateRaw } from '../../../../shared/logic/files/inflate.ts';
import type { RejectReason } from '../../../../shared/schema/attachments.ts';
import { sha256Hex } from '../../../platform/sha256.ts';

export const MAX_BYTES = 10_485_760;

export interface Prepared {
  ok: true;
  kind: DocKind;
  mime: string;
  name: string;
  bytes: Uint8Array;
  sha256: string;
}
/** detail 只进运行日志（哪条规则拒的），reason 给界面 */
export type PrepFail = { ok: false; reason: RejectReason | 'empty'; detail: string };


/** 文件的字节（File.arrayBuffer；测试里的 jsdom 没有时退回 FileReader 一类的 Response 读法） */
async function bytesOf(f: Blob): Promise<Uint8Array> {
  return new Uint8Array(typeof f.arrayBuffer === 'function' ? await f.arrayBuffer() : await new Response(f).arrayBuffer());
}

export async function prepareFile(file: File): Promise<Prepared | PrepFail> {
  if (file.size === 0) return { ok: false, reason: 'empty', detail: 'empty' };
  if (file.size > MAX_BYTES) return { ok: false, reason: 'too_big', detail: 'too_big' };
  const bytes = await bytesOf(file);
  const s = await sniffFile(bytes, inflateRaw);
  if (!s.ok) return { ok: false, reason: s.reason, detail: s.detail };
  const bomb = await zipBombCheck(bytes, inflateRaw);
  if (!bomb.ok) return { ok: false, reason: 'bad_archive', detail: bomb.detail };
  return { ok: true, kind: s.kind, mime: DOC_TYPES[s.kind], name: sanitizeFileName(file.name, s.kind), bytes, sha256: await sha256Hex(bytes) };
}
