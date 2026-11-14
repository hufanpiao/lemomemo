// 附件类型只在这里判（架构 5.13 第 2 点 ①）：只看字节——PDF 签名；ZIP 从末尾读中央目录和 [Content_Types].xml；OLE2 读头、FAT、目录里根下的流名。
// 不变量：不收文件名和 MIME；任何输入都不抛错，只回 kind 或拒因；不读任何流的内容；不记日志（调用方记字节数和结果）。
// 解压函数由调用方传入（客户端 fflate、服务器 DecompressionStream 适配器），shared 不碰运行环境的 API。
// R-408（11-13 负责人定）：设了打开密码的 docx、xlsx、pptx 其实是 OLE2 外壳，根下只有 EncryptionInfo 和 EncryptedPackage 两个流
// （MS-OFFCRYPTO 2.3.4），单独回 reason 'encrypted'，界面提示“带密码的文件不能上传”，不再算“类型不认”；
// 设了密码的 .doc、.xls、.ppt 根下仍有 WordDocument 等流，照旧认成旧格式（这里不读流内容，分不出加没加密）。
// 本文件会复制进 supabase/functions/_shared/gen 受 F7 检查：任意偏移的读取一律经 DataView，魔数写成数字，查表用 Map 或遍历元组。

// 判得出的 10 种附件类型 DocKind 和它们的 MIME 只在 shared/manifests/attachments.ts 的 DOC_TYPES 里列，这里只引类型
import type { DocKind } from '../../manifests/attachments.ts';

// shared 的 lib 里没有 DOM 类型：照 link.ts 只声明用到的 TextDecoder（浏览器、Deno、Node 都有）
declare const TextDecoder: new () => { decode(bytes: Uint8Array): string };

/** 三个家族：一行一个家族；三个 kind 字段受 DocKind 约束 */
const FAMILIES = [
  {
    plain: 'docx', macro: 'docm', legacy: 'doc', streams: ['WordDocument'],
    main: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    macroMain: 'application/vnd.ms-word.document.macroEnabled.main+xml',
  },
  {
    plain: 'xlsx', macro: 'xlsm', legacy: 'xls', streams: ['Workbook', 'Book'],
    main: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    macroMain: 'application/vnd.ms-excel.sheet.macroEnabled.main+xml',
  },
  {
    plain: 'pptx', macro: 'pptm', legacy: 'ppt', streams: ['PowerPoint Document'],
    main: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    macroMain: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
  },
] as const satisfies ReadonlyArray<{ plain: DocKind; macro: DocKind; legacy: DocKind; streams: readonly string[]; main: string; macroMain: string }>;
type Family = (typeof FAMILIES)[number];

type UnknownDetail =
  | 'no_signature' | 'ct_missing' | 'ct_xml_unsafe' | 'ct_no_main' | 'ct_multi_family'
  | 'ole_short' | 'ole_bad_header' | 'ole_bad_fat' | 'ole_dir_chain' | 'ole_no_root' | 'ole_bad_tree'
  | 'ole_no_stream' | 'ole_multi_family' | 'ole_range';
type BadArchiveDetail =
  | 'eocd_missing' | 'eocd_not_at_end' | 'eocd_multi_disk' | 'eocd_count_mismatch' | 'zip64' | 'cd_out_of_range'
  | 'cd_bad_entry' | 'ct_duplicate' | 'ct_encrypted' | 'ct_bad_method' | 'ct_too_big' | 'ct_bad_local'
  | 'ct_data_overrun' | 'ct_size_mismatch' | 'inflate_failed' | 'inflate_size' | 'zip_range'
  | 'bomb_entries' | 'bomb_entry' | 'bomb_total';
/** reason 给界面（类型不认 / 压缩包异常 / 带密码），detail 给运行日志定是哪条规则拒的 */
export type SniffResult =
  | { ok: true; kind: DocKind }
  | { ok: false; reason: 'unknown'; detail: UnknownDetail }
  | { ok: false; reason: 'bad_archive'; detail: BadArchiveDetail }
  | { ok: false; reason: 'encrypted'; detail: 'ole_encrypted_package' };

/** raw deflate；输出超过 maxBytes 必须立刻停下并返回 null（或抛错） */
export type InflateRaw = (deflated: Uint8Array, maxBytes: number) => Uint8Array | null | Promise<Uint8Array | null>;

/** [Content_Types].xml 解压后的上限（真实文件几 KB 到几百 KB） */
export const CONTENT_TYPES_MAX_BYTES = 1_048_576;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const unknown = (detail: UnknownDetail): SniffResult => ({ ok: false, reason: 'unknown', detail });
const bad = (detail: BadArchiveDetail): SniffResult => ({ ok: false, reason: 'bad_archive', detail });
const startsWith = (v: DataView, magic: readonly number[]): boolean =>
  v.byteLength >= magic.length && magic.every((b, i) => v.getUint8(i) === b);

export async function sniffFile(bytes: Uint8Array, inflateRaw: InflateRaw): Promise<SniffResult> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (startsWith(v, PDF_MAGIC)) return { ok: true, kind: 'pdf' };
  if (startsWith(v, ZIP_MAGIC)) {
    try {
      return await sniffZip(bytes, v, inflateRaw);
    } catch {
      return bad('zip_range');
    }
  }
  if (startsWith(v, OLE_MAGIC)) {
    try {
      return sniffOle(v);
    } catch {
      return unknown('ole_range');
    }
  }
  return unknown('no_signature');
}

// ───────── ZIP（APPNOTE 4.3） ─────────

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const EOCD_LEN = 22;
const CEN_LEN = 46;
const LOC_LEN = 30;
const CT_NAME = '[content_types].xml';
const VBA_NAME = 'vbaproject.bin';
const VBA_TYPE = 'application/vnd.ms-office.vbaproject';
/** 主部件类型（小写）→ 家族、是不是 macroEnabled */
const MAIN_TYPES = new Map<string, { f: Family; macro: boolean }>(
  FAMILIES.flatMap((f) => [
    [f.main.toLowerCase(), { f, macro: false }],
    [f.macroMain.toLowerCase(), { f, macro: true }],
  ]),
);
/** ContentType="…" 或 '…'；引号写成 \x22 \x27，免得只认字符串引号的检查把后面的代码当成字符串 */
const CT_ATTR = /\bContentType\s*=\s*(?:\x22([^\x22]*)\x22|\x27([^\x27]*)\x27)/g;

/** ASCII 字母转小写，其他字节原样（名字只按字节比） */
function lowerAscii(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x >= 0x41 && x <= 0x5a ? x + 0x20 : x);
  return s;
}

/** 中央目录里的一条：at 是目录项偏移，name 是 ASCII 小写的名字，raw 是原样的名字字节 */
interface CenEntry {
  at: number;
  name: string;
  raw: Uint8Array;
}
interface ZipDir {
  cd: number;
  entries: CenEntry[];
}

/** 从末尾找结束记录、读整个中央目录（sniffZip 和 zipBombCheck 共用这一份） */
function readZipDir(bytes: Uint8Array, v: DataView): ZipDir | SniffResult {
  // 从末尾往前找第一个结束记录签名，必须连同注释严丝合缝到文件尾
  let eocd = -1;
  const last = v.byteLength - EOCD_LEN;
  for (let p = last; p >= 0 && p >= last - 0xffff; p -= 1) {
    if (v.getUint32(p, true) === EOCD_SIG) {
      eocd = p;
      break;
    }
  }
  if (eocd < 0) return bad('eocd_missing');
  if (eocd + EOCD_LEN + v.getUint16(eocd + 20, true) !== v.byteLength) return bad('eocd_not_at_end');
  if (v.getUint16(eocd + 4, true) !== 0 || v.getUint16(eocd + 6, true) !== 0) return bad('eocd_multi_disk');
  const count = v.getUint16(eocd + 10, true);
  const cdSize = v.getUint32(eocd + 12, true);
  const cd = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cd === 0xffffffff) return bad('zip64');
  if (v.getUint16(eocd + 8, true) !== count) return bad('eocd_count_mismatch');
  if (cd + cdSize > eocd) return bad('cd_out_of_range');
  const entries: CenEntry[] = [];
  let p = cd;
  for (let i = 0; i < count; i += 1) {
    if (p + CEN_LEN > cd + cdSize || v.getUint32(p, true) !== CEN_SIG) return bad('cd_bad_entry');
    const nameLen = v.getUint16(p + 28, true);
    const next = p + CEN_LEN + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    if (next > cd + cdSize) return bad('cd_bad_entry');
    const raw = bytes.subarray(p + CEN_LEN, p + CEN_LEN + nameLen);
    entries.push({ at: p, name: lowerAscii(raw), raw });
    p = next;
  }
  return { cd, entries };
}

async function sniffZip(bytes: Uint8Array, v: DataView, inflateRaw: InflateRaw): Promise<SniffResult> {
  const dir = readZipDir(bytes, v);
  if (!('entries' in dir)) return dir;
  let ctAt = -1;
  let ctCount = 0;
  let vba = false;
  for (const { at, name } of dir.entries) {
    if (name === CT_NAME) {
      ctAt = at;
      ctCount += 1;
    } else if (name === VBA_NAME || name.endsWith(`/${VBA_NAME}`) || name.endsWith(`\\${VBA_NAME}`)) {
      vba = true;
    }
  }
  if (ctCount === 0) return unknown('ct_missing');
  if (ctCount > 1) return bad('ct_duplicate');
  const xml = await readEntry(bytes, v, ctAt, dir.cd, inflateRaw);
  return xml instanceof Uint8Array ? classifyXml(xml, vba) : xml;
}

/** 目录项 at 处那个条目在文件里的数据段（本地头核对过）；大小只信目录里的 */
function entryData(bytes: Uint8Array, v: DataView, at: number, cd: number): { method: number; size: number; data: Uint8Array } | SniffResult {
  const method = v.getUint16(at + 10, true);
  const comp = v.getUint32(at + 20, true);
  const loc = v.getUint32(at + 42, true);
  if (v.getUint16(at + 8, true) & 1) return bad('ct_encrypted');
  if (method !== 0 && method !== 8) return bad('ct_bad_method');
  if (loc + LOC_LEN > cd) return bad('ct_data_overrun');
  if (v.getUint32(loc, true) !== LOC_SIG) return bad('ct_bad_local');
  const start = loc + LOC_LEN + v.getUint16(loc + 26, true) + v.getUint16(loc + 28, true);
  if (start + comp > cd) return bad('ct_data_overrun');
  return { method, size: v.getUint32(at + 24, true), data: bytes.subarray(start, start + comp) };
}

/** 读中央目录 at 处那个条目的内容；大小只信目录里的，声明大小只当上限 */
async function readEntry(bytes: Uint8Array, v: DataView, at: number, cd: number, inflateRaw: InflateRaw): Promise<Uint8Array | SniffResult> {
  if (v.getUint32(at + 24, true) > CONTENT_TYPES_MAX_BYTES) return bad('ct_too_big');
  const e = entryData(bytes, v, at, cd);
  if (!('data' in e)) return e;
  if (e.method === 0) return e.data.length === e.size ? e.data : bad('ct_size_mismatch');
  let out: Uint8Array | null;
  try {
    out = await inflateRaw(e.data, e.size);
  } catch {
    return bad('inflate_failed');
  }
  if (!(out instanceof Uint8Array)) return bad('inflate_failed');
  return out.length === e.size ? out : bad('inflate_size');
}

// ───────── 列出 ZIP 里的条目（预览沙箱里给 docx-preview、PPT 退路读包用，src/preview-frame/zip-lite.ts） ─────────

/** 一个条目：名字按 UTF-8 解（Office 写的都是 ASCII 或 UTF-8）、压缩方式、目录里的解压后大小（只当上限）、文件里的数据段 */
export interface ZipItem {
  name: string;
  method: number;
  size: number;
  data: Uint8Array;
}

/** 读中央目录列出全部条目；结构不对、加密、不认的压缩方式回 null（同 sniffZip、zipBombCheck 一套读法） */
export function zipItems(bytes: Uint8Array): ZipItem[] | null {
  try {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!startsWith(v, ZIP_MAGIC)) return null;
    const dir = readZipDir(bytes, v);
    if (!('entries' in dir)) return null;
    const dec = new TextDecoder();
    const out: ZipItem[] = [];
    for (const { at, raw } of dir.entries) {
      const e = entryData(bytes, v, at, dir.cd);
      if (!('data' in e)) return null;
      out.push({ name: dec.decode(raw), method: e.method, size: e.size, data: e.data });
    }
    return out;
  } catch {
    return null;
  }
}

// ───────── ZIP 炸弹：按真实解压出来的字节数（架构 5.13 第 2 点 ②、架构约定 9.7） ─────────

/** 实际解压量合计、单个条目、条目数的上限（中央目录里声明的大小可以造假，一律不作依据） */
export const ZIP_LIMITS = { totalBytes: 104_857_600, entryBytes: 52_428_800, entries: 2000 } as const;

export type BombResult = { ok: true; total: number } | { ok: false; reason: 'bad_archive'; detail: BadArchiveDetail };

/** SniffResult 里的拒因 → 压缩包异常的 detail（读目录、读数据段只会回 bad_archive 一类） */
const detailOf = (r: SniffResult): BadArchiveDetail => (!r.ok && r.reason === 'bad_archive' ? r.detail : 'zip_range');

/**
 * 把每个条目真的解压一遍、只计数不保存：合计 ≤ 100 MB、单个 ≤ 50 MB、条目 ≤ 2000，超了就拒（上传前、预览前在本机跑）。
 * 只对 ZIP 家族（docx、xlsx、pptx 和带宏的三种）有意义；不是 ZIP 的回 ok（PDF、OLE2 不经这里）
 */
export async function zipBombCheck(
  bytes: Uint8Array,
  inflateRaw: InflateRaw,
  limits: { totalBytes: number; entryBytes: number; entries: number } = ZIP_LIMITS,
): Promise<BombResult> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!startsWith(v, ZIP_MAGIC)) return { ok: true, total: 0 };
  const fail = (detail: BadArchiveDetail): BombResult => ({ ok: false, reason: 'bad_archive', detail });
  try {
    const dir = readZipDir(bytes, v);
    if (!('entries' in dir)) return fail(detailOf(dir));
    if (dir.entries.length > limits.entries) return fail('bomb_entries');
    let total = 0;
    for (const { at } of dir.entries) {
      const e = entryData(bytes, v, at, dir.cd);
      if (!('data' in e)) return fail(detailOf(e));
      const cap = Math.min(limits.entryBytes, limits.totalBytes - total);
      let n = e.data.length;
      if (e.method === 8) {
        let out: Uint8Array | null;
        try {
          out = await inflateRaw(e.data, cap);
        } catch {
          return fail('inflate_failed');
        }
        // 超过上限时解压函数回 null（InflateRaw 的约定：超了立刻停）
        if (!(out instanceof Uint8Array)) return fail(cap < limits.entryBytes ? 'bomb_total' : 'bomb_entry');
        n = out.length;
      }
      if (n > limits.entryBytes) return fail('bomb_entry');
      total += n;
      if (total > limits.totalBytes) return fail('bomb_total');
    }
    return { ok: true, total };
  } catch {
    return fail('zip_range');
  }
}

/** 收集所有 ContentType 值，恰好一个家族的主部件才认 */
function classifyXml(xml: Uint8Array, vba: boolean): SniffResult {
  let s = '';
  for (const x of xml) s += String.fromCharCode(x);
  // 注释、CDATA、DOCTYPE 和实体 Office 都不产出，有了就和 Office 的解析结果可能不一致
  if (s.includes('<!')) return unknown('ct_xml_unsafe');
  let family: Family | undefined;
  let macro = vba;
  for (const m of s.matchAll(CT_ATTR)) {
    const value = (m[1] ?? m[2] ?? '').toLowerCase();
    if (value.includes('&')) return unknown('ct_xml_unsafe');
    if (value === VBA_TYPE) macro = true;
    const hit = MAIN_TYPES.get(value);
    if (!hit) continue;
    if (family && family !== hit.f) return unknown('ct_multi_family');
    family = hit.f;
    macro ||= hit.macro;
  }
  if (!family) return unknown('ct_no_main');
  return { ok: true, kind: macro ? family.macro : family.plain };
}

// ───────── OLE2 复合文档（MS-CFB 2.2） ─────────

const OLE_HEADER = 512;
const END_OF_CHAIN = 0xfffffffe;
const NO_STREAM = 0xffffffff;
const DIR_ENTRY = 128;
/** 带打开密码的 OOXML：根下这两个流都在（只有其中一个不算） */
const ENCRYPTED_STREAMS = ['EncryptionInfo', 'EncryptedPackage'] as const;
const HEADER_DIFAT = 109;

function sniffOle(v: DataView): SniffResult {
  if (v.byteLength < OLE_HEADER) return unknown('ole_short');
  const shift = v.getUint16(30, true);
  if (v.getUint16(28, true) !== 0xfffe || (shift !== 9 && shift !== 12)) return unknown('ole_bad_header');
  const size = 2 ** shift;
  /** 文件里的扇区数（扇区 n 在 (n+1)×size）；特殊值都远大于它 */
  const sectors = Math.ceil(v.byteLength / size) - 1;
  const fat = fatSectors(v, size, sectors);
  if (!fat) return unknown('ole_bad_fat');
  const perFat = size / 4;
  const next = (n: number): number => {
    const s = fat.at(Math.floor(n / perFat));
    return s === undefined ? NO_STREAM : v.getUint32((s + 1) * size + (n % perFat) * 4, true);
  };

  const dirs: number[] = [];
  for (let s = v.getUint32(48, true); s !== END_OF_CHAIN; s = next(s)) {
    if (s >= sectors || dirs.length >= sectors) return unknown('ole_dir_chain');
    dirs.push(s);
  }
  const perDir = size / DIR_ENTRY;
  const total = dirs.length * perDir;
  const entry = (k: number): number => ((dirs.at(Math.floor(k / perDir)) ?? 0) + 1) * size + (k % perDir) * DIR_ENTRY;
  if (total === 0 || v.getUint8(entry(0) + 66) !== 5) return unknown('ole_no_root');

  // 只沿左右兄弟走根的直接子项，不进子存储（PPT 里嵌的 Excel 不算）
  const seen = new Set<number>([0]);
  const stack = [v.getUint32(entry(0) + 76, true)];
  let family: Family | undefined;
  const encrypted = new Set<string>();
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (id === NO_STREAM) continue;
    if (id >= total || seen.has(id)) return unknown('ole_bad_tree');
    seen.add(id);
    const at = entry(id);
    stack.push(v.getUint32(at + 68, true), v.getUint32(at + 72, true));
    if (v.getUint8(at + 66) !== 2) continue;
    const name = entryName(v, at);
    if (ENCRYPTED_STREAMS.some((n) => n === name)) encrypted.add(name);
    const f = FAMILIES.find((x) => x.streams.some((n) => n === name));
    if (!f) continue;
    if (family && family !== f) return unknown('ole_multi_family');
    family = f;
  }
  if (family) return { ok: true, kind: family.legacy };
  return encrypted.size === ENCRYPTED_STREAMS.length ? { ok: false, reason: 'encrypted', detail: 'ole_encrypted_package' } : unknown('ole_no_stream');
}

/** FAT 扇区号：头里 109 项，不够再沿 DIFAT 链（512 字节扇区的文件约 6.8 MB 起用到） */
function fatSectors(v: DataView, size: number, sectors: number): number[] | null {
  const want = v.getUint32(44, true);
  if (want > sectors) return null;
  const fat: number[] = [];
  for (let i = 0; i < HEADER_DIFAT && fat.length < want; i += 1) fat.push(v.getUint32(76 + i * 4, true));
  const per = size / 4 - 1;
  // 每轮至少收一项，want 有上限，链成环也会停
  for (let s = v.getUint32(68, true); fat.length < want; s = v.getUint32((s + 1) * size + per * 4, true)) {
    if (s >= sectors) return null;
    for (let i = 0; i < per && fat.length < want; i += 1) fat.push(v.getUint32((s + 1) * size + i * 4, true));
  }
  return fat.every((s) => s < sectors) ? fat : null;
}

/** 目录条目名：UTF-16LE，长度字段含结尾的 0；长度不合法当空名 */
function entryName(v: DataView, at: number): string {
  const len = v.getUint16(at + 64, true);
  if (len < 2 || len > 64 || len % 2 !== 0) return '';
  let s = '';
  for (let i = 0; i < len / 2 - 1; i += 1) s += String.fromCharCode(v.getUint16(at + i * 2, true));
  return s;
}
