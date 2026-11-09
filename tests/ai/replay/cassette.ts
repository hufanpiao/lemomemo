// AI 回放（B3 任务单 BE-6；TC-B0-90、TC-B1-15、TC-B3-06、07、25）：录制器和回放桩共用的格式与去密钥工具。
// • 回放文件只存：方法、去掉查询串的地址、请求体、HTTP 状态、返回正文；**请求头、返回头一律不存**（含 x-goog-api-key，15.3 第 6 条）；
// • 存盘前再扫一遍：录制时用的密钥原值换成 [REDACTED]，任何长得像谷歌 API 密钥的串（AIza 开头）都拒绝存盘；
// • 录音只在内存、不落盘（5.11 第 3 点、A23；BE-6 安全审 M1）：请求体里 inlineData.data 换成占位串（只留原长度和 SHA-256），
//   存盘前发现 inlineData.data 不是占位串就拒绝；
// • 谷歌错误正文里的 projects/<编号>、控制台链接的 project=<ID> 换成 [REDACTED]（安全审建议 2），不暴露 GCP 项目；
// • secrets 必传；录制器录的（origin = recorded）secrets 为空直接拒绝存盘（安全审建议 1）；
// • gitleaks（.githooks/pre-commit 和 unit.yml 的 secrets-scan）用默认规则扫全仓，tests/ 不放行，回放文件里漏了密钥照样被拦。
// 纯 Node，不碰网络。
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CASSETTE_VERSION = 1;
export const REDACTED = '[REDACTED]';

/** 一次调用：timeout 表示录制时到点被中止（回放时挂起到调用方中止为止） */
export type CassetteRes = { kind: 'http'; status: number; body: string } | { kind: 'timeout' };
export interface CassetteEntry {
  req: { method: string; url: string; body: unknown };
  res: CassetteRes;
}
export interface Cassette {
  v: typeof CASSETTE_VERSION;
  provider: 'gemini';
  /** 怎么来的：recorded（录制器录的）或 handmade（手写，格式和录制器产出一致） */
  origin: 'recorded' | 'handmade';
  note: string;
  entries: CassetteEntry[];
}

/** 谷歌 API 密钥的样子（同 build/check_arch.py A14 的 Google API key 一条，放宽到 30 位以上） */
export const GOOGLE_KEY_RE = /AIza[0-9A-Za-z_-]{30,}/g;

/** 录音占位串：只留原长度（base64 字符数）和 SHA-256（十六进制），方便核对是哪一段，不留内容 */
export const AUDIO_PLACEHOLDER_RE = /^\[AUDIO len=\d+ sha256=[0-9a-f]{64}\]$/;
export const audioPlaceholder = (b64: string): string => `[AUDIO len=${b64.length} sha256=${createHash('sha256').update(b64).digest('hex')}]`;

/** 把对象里所有 inlineData.data 换成占位串（mimeType 留着）；别的原样。
 *  只认驼峰的 inlineData（_shared/ai/gemini.ts 现在发的写法）；Gemini 也接受下划线的 inline_data，
 *  以后 gemini.ts 改用 inline_data 时，这里和下面的 hasAudio 要同步认这个键（安全复审第三条）。 */
export function stripAudio<T>(v: T): T {
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (x === null || typeof x !== 'object') return x;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(x)) {
      if (k === 'inlineData' && val !== null && typeof val === 'object' && !Array.isArray(val)) {
        const d = (val as Record<string, unknown>)['data'];
        out[k] = { ...(walk(val) as Record<string, unknown>), ...(typeof d === 'string' && !AUDIO_PLACEHOLDER_RE.test(d) ? { data: audioPlaceholder(d) } : {}) };
      } else {
        out[k] = walk(val);
      }
    }
    return out;
  };
  return walk(v) as T;
}

/** 找出所有 inlineData.data 里不是占位串的（录音漏进来了） */
function hasAudio(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(hasAudio);
  if (x === null || typeof x !== 'object') return false;
  return Object.entries(x).some(([k, val]) => {
    if (k === 'inlineData' && val !== null && typeof val === 'object') {
      const d = (val as Record<string, unknown>)['data'];
      if (d !== undefined && !(typeof d === 'string' && AUDIO_PLACEHOLDER_RE.test(d))) return true;
    }
    return hasAudio(val);
  });
}

/** GCP 项目标识：projects/<编号或 ID>、控制台链接的 project=<ID> */
const PROJECT_RE = /projects\/(?!\[REDACTED\])[A-Za-z0-9_-]+/g;
const PROJECT_QS_RE = /([?&]project=)(?!\[REDACTED\])[^&"\s]+/g;
/** 谷歌错误详情里的 project_number:<编号>（安全复审补） */
const PROJECT_NUM_RE = /(project_number:\s*)(?!\[REDACTED\])\d+/g;

/** 地址只留协议、主机、路径（查询串里可能带 key=） */
export function stripQuery(url: string): string {
  const u = new URL(url);
  return `${u.origin}${u.pathname}`;
}

/** 把字符串里出现的密钥原值和像密钥的串都换成 [REDACTED]；对象逐层处理（键名也处理） */
export function scrub<T>(v: T, secrets: readonly string[]): T {
  const s = (x: string): string => {
    let out = x;
    for (const k of secrets) if (k) out = out.split(k).join(REDACTED);
    return out.replace(GOOGLE_KEY_RE, REDACTED).replace(PROJECT_RE, `projects/${REDACTED}`).replace(PROJECT_QS_RE, `$1${REDACTED}`).replace(PROJECT_NUM_RE, `$1${REDACTED}`);
  };
  const walk = (x: unknown): unknown => {
    if (typeof x === 'string') return s(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x !== null && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, val]) => [s(k), walk(val)]));
    return x;
  };
  return walk(v) as T;
}

/** 回放文件里还剩哪些可疑的东西：密钥原值、像谷歌密钥的串、名字像请求头的键、录音、GCP 项目标识 */
export function leftovers(c: Cassette, secrets: readonly string[]): string[] {
  const text = JSON.stringify(c);
  const found: string[] = [];
  for (const k of secrets) if (k && text.includes(k)) found.push('secret_value');
  if (new RegExp(GOOGLE_KEY_RE.source).test(text)) found.push('google_key_like');
  if (/"headers"\s*:/i.test(text) || /x-goog-api-key/i.test(text)) found.push('headers');
  if (hasAudio(c)) found.push('audio');
  if ([PROJECT_RE, PROJECT_QS_RE, PROJECT_NUM_RE].some((re) => new RegExp(re.source).test(text))) found.push('project_id');
  return found;
}

/** 存盘：先确认干净，不干净就抛错、什么都不写。secrets 传录制时用过的密钥原值；录制器录的不传（空）直接拒绝 */
export function saveCassette(path: string, c: Cassette, secrets: readonly string[]): void {
  if (c.origin === 'recorded' && secrets.filter((k) => k !== '').length === 0) throw new Error('cassette_no_secrets');
  const bad = leftovers(c, secrets);
  if (bad.length > 0) throw new Error(`cassette_not_clean:${bad.join(',')}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(c, null, 2)}\n`, 'utf8');
}

export function loadCassette(path: string | URL): Cassette {
  const c = JSON.parse(readFileSync(path, 'utf8')) as Cassette;
  if (c.v !== CASSETTE_VERSION || c.provider !== 'gemini' || !Array.isArray(c.entries)) throw new Error('bad_cassette');
  return c;
}
