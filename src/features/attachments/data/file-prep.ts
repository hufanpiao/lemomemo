// 加附件前在本机先判一遍（架构 5.13 第 2 点 ①②③⑤）：大小 ≤ 10 MB、按内容判类型（shared/logic/files/file-sniff.ts，和服务器 file-check 同一份）、
// ZIP 家族按真实解压字节数查炸弹（zipBombCheck）、算整个文件的 sha256、清理文件名（扩展名按判出的类型重写）。元数据原样保存（D-5），不改字节。
// 代定（B4b-1）：这一步在主页面跑、不进预览沙箱的 Worker——这里只有我们自己的判型代码（服务器同跑），解压用浏览器原生的
//   DecompressionStream（异步、不占主线程），第三方解析库（pdf.js、docx-preview、SheetJS）仍只在预览沙箱里。
//   首页缩略图、页数和抽文字（第 2 点 ④）由隐藏的预览沙箱给（prep-client.ts），这里的 prepWithExtras 只负责先判、再调它。
// 纯 TS：不准 import React（A1）
import type { Extract, Extras } from './attach-uploader.ts';
import { DOC_TYPES, type DocKind } from '../../../../shared/manifests/attachments.ts';
import { sanitizeFileName } from '../../../../shared/logic/files/file-name.ts';
import { FILE_MAX_BYTES } from '../../../../shared/logic/files/limits.ts';
import { sniffFile, zipBombCheck } from '../../../../shared/logic/files/file-sniff.ts';
import { inflateRaw } from '../../../../shared/logic/files/inflate.ts';
import type { RejectReason } from '../../../../shared/schema/attachments.ts';
import { sha256Hex } from '../../../platform/sha256.ts';


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
  if (file.size > FILE_MAX_BYTES) return { ok: false, reason: 'too_big', detail: 'too_big' };
  const bytes = await bytesOf(file);
  const s = await sniffFile(bytes, inflateRaw);
  if (!s.ok) return { ok: false, reason: s.reason, detail: s.detail };
  const bomb = await zipBombCheck(bytes, inflateRaw);
  if (!bomb.ok) return { ok: false, reason: 'bad_archive', detail: bomb.detail };
  return { ok: true, kind: s.kind, mime: DOC_TYPES[s.kind], name: sanitizeFileName(file.name, s.kind), bytes, sha256: await sha256Hex(bytes) };
}

/**
 * 本机判 + 抽预览材料（普通随手记的上传器、隐私记附件共用，评审 12）：判不过回 PrepFail；extract 给不出（或没给）x 为 null。
 * 运行日志前缀 tag（att / vatt），只记类型、大小、页数、有没有缩略图、字数、拒的规则名
 */
export async function prepWithExtras(
  file: File,
  prepare: (f: File) => Promise<Prepared | PrepFail>,
  extract: Extract | undefined,
  log: (line: string) => void,
  tag: string,
): Promise<{ ok: true; p: Prepared; x: Extras | null } | PrepFail> {
  const p = await prepare(file);
  log(p.ok ? `${tag} prep ok kind=${p.kind} kb=${Math.round(p.bytes.length / 1024)}` : `${tag} prep ${p.reason} detail=${p.detail}`);
  if (!p.ok) return p;
  const x = extract ? await extract(p.bytes, p.kind).catch(() => null) : null;
  if (extract) log(`${tag} extract ${x ? `ok pages=${x.pages ?? '-'} thumb=${x.thumb ? 1 : 0} chars=${x.text?.length ?? 0}` : 'none'}`);
  return { ok: true, p, x };
}
