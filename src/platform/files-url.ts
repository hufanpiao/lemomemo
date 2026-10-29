// 照片和附件的地址核对（从 platform/files.ts 拆出，W1 超行；架构 0.32；14.2 第 3 点）
// - 只认 images、files 两个桶；路径段只挡明显不对的写法（精确的正则在服务器）
// - 对象地址、ms 签名链接、X-Files-Sig 的值：先核对来源和路径前缀（不只比字符串前缀）
// 纯函数，不发请求；platform/files.ts 原样再导出（调用方照旧从 files.ts 引）

export const FILE_BUCKETS = ['images', 'files'] as const;
export type FileBucket = (typeof FILE_BUCKETS)[number];

// ───────── 路径和链接的核对 ─────────

// 路径段：小写十六进制 uuid、anniv、带扩展名的文件名（images：<uid>/<note>/<id>(.t).webp、<uid>/anniv/<anniv>/<avatar>.webp；
// files：<uid>/<note>/<id>.<ext>、<id>.t.webp）。精确的正则在服务器（清单 pathPattern），这里只挡明显不对的
const SEGMENT = /^[0-9a-z][0-9a-z_-]*(\.[0-9a-z]+)*$/;

export function isFileBucket(b: string): b is FileBucket {
  return (FILE_BUCKETS as readonly string[]).includes(b);
}

/** 2～4 段、每段只有小写字母数字和 . _ -、不以点开头，没有 ..、%、\、空段 */
export function isSafePath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  const segs = path.split('/');
  return segs.length >= 2 && segs.length <= 4 && segs.every((s) => SEGMENT.test(s));
}

/** /files/v1/ 的地址规范成以 / 结尾（files.ts 的客户端也用） */
export function baseUrl(base: string): URL {
  const u = new URL(base);
  if (!u.pathname.endsWith('/')) u.pathname += '/';
  return u;
}

type Expect = { bucket: FileBucket; path: string };

/**
 * 核对地址的来源和路径（view、download 不带查询串，ms 只许 e、s）：来源（scheme、主机、端口）等于本站；
 * 路径正好是 <base>o/<桶>/<路径>，桶和路径过 isSafePath；原文和解析结果逐字一致（挡 ..、百分号编码、反斜杠这类被 URL 解析器“规范化”掉的写法）。
 * expect 给了就要求桶和路径正好是这一项。通过时返回解析结果，否则 null
 */
function checkObjectPart(raw: string, base: string, withQuery: boolean, expect?: Expect): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const b = baseUrl(base);
  if (u.origin !== b.origin || u.username !== '' || u.password !== '' || u.hash !== '') return null;
  const prefix = `${b.pathname}o/`;
  if (!u.pathname.startsWith(prefix)) return null;
  const rest = u.pathname.slice(prefix.length);
  const slash = rest.indexOf('/');
  const bucket = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (slash <= 0 || !isFileBucket(bucket) || !isSafePath(path)) return null;
  if (expect && (expect.bucket !== bucket || expect.path !== path)) return null;
  const q = raw.indexOf('?');
  if (!withQuery) return q < 0 && raw === `${u.origin}${u.pathname}` ? u : null;
  if (q < 0 || raw.slice(0, q) !== `${u.origin}${u.pathname}`) return null;
  return u;
}

/** view、download 的对象地址：同上，且没有查询串 */
export function checkObjectUrl(raw: string, base: string, expect?: Expect): boolean {
  return checkObjectPart(raw, base, false, expect) !== null;
}

/** `k=v&…` 只许 keys 里的键、不重复，e 是数字、s 不空；通过时返回各键的值 */
function sigPairs(raw: string, keys: readonly string[]): URLSearchParams | null {
  const q = new URLSearchParams(raw);
  const got = [...q.keys()];
  if (got.some((k) => !keys.includes(k)) || new Set(got).size !== got.length) return null;
  return /^\d{1,12}$/.test(q.get('e') ?? '') && q.get('s') ? q : null;
}

/** ms 的签名链接：查询串只有 e、s，e 是数字；返回到期时刻（毫秒），否则 null */
export function checkMsUrl(raw: string, base: string, expect?: Expect): number | null {
  const u = checkObjectPart(raw, base, true, expect);
  const q = u ? sigPairs(u.search, ['e', 's']) : null;
  return q ? Number(q.get('e')) * 1000 : null;
}

/**
 * X-Files-Sig 的值：p=view|download&e=<数字>&d=<编码过的文件名>&s=<签名>，只有可打印 ASCII、键不重复。
 * want 给了就要求 p 正好是这个用途。返回到期时刻（毫秒），否则 null
 */
export function checkSig(sig: string, want?: 'view' | 'download'): number | null {
  if (sig.length > 2048 || !/^[!-~]+$/.test(sig)) return null;
  const q = sigPairs(sig, ['p', 'e', 'd', 's']);
  const p = q?.get('p');
  if (!q || (p !== 'view' && p !== 'download') || (want !== undefined && p !== want)) return null;
  return Number(q.get('e')) * 1000;
}
