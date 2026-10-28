// /files/v1/* 各路由共用的类型和小工具（functions/files/[[path]].ts 和 files-sign-route.ts 用）。
// 错误体一律 {code, reason?}；每个响应都带 /files 的安全头和 CORS（只认 tauri.localhost）。
import type { ObjStore } from '../../shared/objstore.ts';
import type { VersionGate } from '../sb/version-gate.ts';
import { applyCors } from './cors.ts';
import type { AuthzConfig } from './files-authorize.ts';
import { MIN_SECRET_LENGTH } from './files-sign.ts';
import type { FixedLength } from './files-upload.ts';
import { applyFilesSecurityHeaders } from './security-headers.ts';

export interface FilesEnv {
  SUPABASE_UPSTREAM: string;
  SUPABASE_ANON_KEY: string;
  /** R2 的 S3 地址；本机和 CI 指向替身（8.4、8.6） */
  R2_ENDPOINT: string;
  /** 预览 'preview-'，正式空 */
  R2_BUCKET_PREFIX?: string;
  /** 默认 'auto'（R2）；替身要别的区域时才写 */
  R2_REGION?: string;
  R2_FILES_ACCESS_KEY_ID: string;
  R2_FILES_SECRET_ACCESS_KEY: string;
  /** 签链接的 HMAC 密钥，至少 32 个字符 */
  FILES_URL_SECRET: string;
}

export interface FilesDeps {
  /** 调 files_authorize（和 version-gate 读配置不同，这里要带用户的 JWT） */
  fetch: (req: Request) => Promise<Response>;
  store: ObjStore;
  gate: VersionGate;
  /** 毫秒 */
  now: () => number;
  /** 只记错误码和耗时 */
  log: (code: string, ms: number) => void;
  /** Cloudflare 的 FixedLengthStream；没有就读进内存 */
  fixedLength?: FixedLength;
  authzTimeoutMs?: number;
}

// 路径里只许小写字母、数字、- . / ；点段、双斜杠、百分号编码一律拒（和 /sb 同一个思路：用原始字符串判断）
/** sign 的 d（下载文件名）原始长度上限；GET 的 d 是编码后的，按 4 倍放宽 */
export const MAX_NAME_INPUT = 255;

export const PATH_RE = /^[a-z0-9][a-z0-9./-]*$/;
export const SUSPICIOUS_RE = /\/\/|(^|\/)\.\.?(\/|$)/;

export function json(status: number, body: Record<string, unknown>, origin: string | null, extra?: Record<string, string>): Response {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  for (const [k, v] of Object.entries(extra ?? {})) h.set(k, v);
  applyFilesSecurityHeaders(h);
  applyCors(h, origin);
  return new Response(JSON.stringify(body), { status, headers: h });
}

export const err = (status: number, code: string, origin: string | null, reason?: string) =>
  json(status, reason === undefined ? { code } : { code, reason }, origin);

export function bearerOf(request: Request): string | null {
  const a = request.headers.get('Authorization') ?? '';
  return /^Bearer [A-Za-z0-9._~+/=-]{10,4096}$/.test(a) ? a : null;
}

export function secretOk(env: FilesEnv): boolean {
  return typeof env.FILES_URL_SECRET === 'string' && env.FILES_URL_SECRET.length >= MIN_SECRET_LENGTH;
}

export function authzConfig(env: FilesEnv, deps: FilesDeps): AuthzConfig {
  return { upstream: env.SUPABASE_UPSTREAM, anonKey: env.SUPABASE_ANON_KEY, fetch: deps.fetch, ...(deps.authzTimeoutMs ? { timeoutMs: deps.authzTimeoutMs } : {}) };
}
