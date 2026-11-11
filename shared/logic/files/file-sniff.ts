// 附件类型只在这里判（架构 5.13 第 2 点 ①）：只看字节——PDF 签名；ZIP 从末尾读中央目录和 [Content_Types].xml；OLE2 读头、FAT、目录里根下的流名。
// 不变量：不收文件名和 MIME；任何输入都不抛错，只回 kind 或拒因；不读任何流的内容；不记日志（调用方记字节数和结果）。
// 解压函数由调用方传入（客户端 fflate、服务器 DecompressionStream 适配器），shared 不碰运行环境的 API。
// 本文件会复制进 supabase/functions/_shared/gen 受 F7 检查：任意偏移的读取一律经 DataView，魔数写成数字，查表用 Map 或遍历元组。

/** 附件可收的 10 种类型 → MIME（R-114 D-4）。全仓唯一一份：清单的 allowedMimeTypes、桶路径的扩展名、/files 的 Content-Type 都从这里推导 */
export const DOC_KINDS = [
  ['pdf', 'application/pdf'],
  ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['docm', 'application/vnd.ms-word.document.macroEnabled.12'],
  ['xlsm', 'application/vnd.ms-excel.sheet.macroEnabled.12'],
  ['pptm', 'application/vnd.ms-powerpoint.presentation.macroEnabled.12'],
  ['doc', 'application/msword'],
  ['xls', 'application/vnd.ms-excel'],
  ['ppt', 'application/vnd.ms-powerpoint'],
] as const;
export type DocKind = (typeof DOC_KINDS)[number][0];

/** 三个家族：一行一个家族；三个 kind 字段受 DocKind 约束，DOC_KINDS 里删了某种类型 tsc 就报 */
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
  | 'ct_data_overrun' | 'ct_size_mismatch' | 'inflate_failed' | 'inflate_size' | 'zip_range';
/** reason 给界面（类型不认 / 压缩包异常），detail 给运行日志定是哪条规则拒的 */
export type SniffResult =
  | { ok: true; kind: DocKind }
  | { ok: false; reason: 'unknown'; detail: UnknownDetail }
  | { ok: false; reason: 'bad_archive'; detail: BadArchiveDetail };

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

async function sniffZip(bytes: Uint8Array, v: DataView, inflateRaw: InflateRaw): Promise<SniffResult> {
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

  let ctAt = -1;
  let ctCount = 0;
  let vba = false;
  let p = cd;
  for (let i = 0; i < count; i += 1) {
    if (p + CEN_LEN > cd + cdSize || v.getUint32(p, true) !== CEN_SIG) return bad('cd_bad_entry');
    const nameLen = v.getUint16(p + 28, true);
    const next = p + CEN_LEN + nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
    if (next > cd + cdSize) return bad('cd_bad_entry');
    const name = lowerAscii(bytes.subarray(p + CEN_LEN, p + CEN_LEN + nameLen));
    if (name === CT_NAME) {
      ctAt = p;
      ctCount += 1;
    } else if (name === VBA_NAME || name.endsWith(`/${VBA_NAME}`) || name.endsWith(`\\${VBA_NAME}`)) {
      vba = true;
    }
    p = next;
  }
  if (ctCount === 0) return unknown('ct_missing');
  if (ctCount > 1) return bad('ct_duplicate');
  const xml = await readEntry(bytes, v, ctAt, cd, inflateRaw);
  return xml instanceof Uint8Array ? classifyXml(xml, vba) : xml;
}

/** 读中央目录 at 处那个条目的内容；大小只信目录里的，声明大小只当上限 */
async function readEntry(bytes: Uint8Array, v: DataView, at: number, cd: number, inflateRaw: InflateRaw): Promise<Uint8Array | SniffResult> {
  const method = v.getUint16(at + 10, true);
  const comp = v.getUint32(at + 20, true);
  const size = v.getUint32(at + 24, true);
  const loc = v.getUint32(at + 42, true);
  if (v.getUint16(at + 8, true) & 1) return bad('ct_encrypted');
  if (method !== 0 && method !== 8) return bad('ct_bad_method');
  if (size > CONTENT_TYPES_MAX_BYTES) return bad('ct_too_big');
  if (loc + LOC_LEN > cd) return bad('ct_data_overrun');
  if (v.getUint32(loc, true) !== LOC_SIG) return bad('ct_bad_local');
  const start = loc + LOC_LEN + v.getUint16(loc + 26, true) + v.getUint16(loc + 28, true);
  if (start + comp > cd) return bad('ct_data_overrun');
  const data = bytes.subarray(start, start + comp);
  if (method === 0) return comp === size ? data : bad('ct_size_mismatch');
  let out: Uint8Array | null;
  try {
    out = await inflateRaw(data, size);
  } catch {
    return bad('inflate_failed');
  }
  if (!(out instanceof Uint8Array)) return bad('inflate_failed');
  return out.length === size ? out : bad('inflate_size');
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
  for (let id = stack.pop(); id !== undefined; id = stack.pop()) {
    if (id === NO_STREAM) continue;
    if (id >= total || seen.has(id)) return unknown('ole_bad_tree');
    seen.add(id);
    const at = entry(id);
    stack.push(v.getUint32(at + 68, true), v.getUint32(at + 72, true));
    if (v.getUint8(at + 66) !== 2) continue;
    const name = entryName(v, at);
    const f = FAMILIES.find((x) => x.streams.some((n) => n === name));
    if (!f) continue;
    if (family && family !== f) return unknown('ole_multi_family');
    family = f;
  }
  return family ? { ok: true, kind: family.legacy } : unknown('ole_no_stream');
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
