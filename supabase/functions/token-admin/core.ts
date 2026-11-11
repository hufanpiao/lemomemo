// token-admin（架构 5.7、第 6 节函数表 token-admin 行；R-65；S-B3 中 6；B3 任务单 BE-5、TC-B3-19～21）。
// 只有一个动作 create {action: 'create', label?}：
//   方法（只收 POST）→ JWT（requireActiveUser，index.ts 注入）→ 请求体（label 去首尾空白、≤ 40 字、不准控制字符和双向覆盖字符）
//   → 同时有效的连接码最多 5 个（安全审 M2，超了 409 too_many_tokens）→ 每人每天 10 次（键 token-admin:<user_id>:<UTC 日期>，private.take_rate，窗口 86400 秒）
//   → 生成连接码（_shared/intake-token.ts），库里只存哈希，scopes 固定 {create}（只能新增）
//   → 回 {token, id, expires_at}：明文码只出现在这一次响应里（设置页只显示这一次、不做成可点链接）。
// 列表、最后使用时间：客户端经 RLS 直接读 api_tokens（tok_sel）；断开连接：客户端 PATCH revoked_at（guard_token_revoke），都不经这里。
// 版本门在 index.ts 入口处查（标“查”）。日志只记错误码，不打印码、哈希、label。纯逻辑：依赖全部注入。
import { randomToken, tokenHash, TOKEN_TTL_MS } from '../_shared/intake-token.ts';

export const DAILY_LIMIT = 10;
export const LABEL_MAX = 40;
/** 同时有效（没吊销、180 天内）的连接码最多几个（安全审 M2）；超了回 409 too_many_tokens，要先在设置里断开一个 */
export const MAX_ACTIVE = 5;
const MAX_BODY = 2048;
const INSERT_ATTEMPTS = 3;

export type AuthResult = { ok: true; user: { userId: string } } | { ok: false; response: Response };

export interface Store {
  takeRate(key: string, limit: number, windowS: number): Promise<boolean>;
  /** 插入一行：ok 回 {id, created_at}；token_hash 撞了回 'duplicate'；别的错抛错 */
  /** 这个人现在有效的连接码个数（revoked_at 为空、created_at 晚于 sinceIso） */
  activeCount(userId: string, sinceIso: string): Promise<number>;
  insertToken(row: { user_id: string; label: string | null; token_hash: string; scopes: string[] }): Promise<{ id: string; created_at: string } | 'duplicate'>;
}

export interface Deps {
  authenticate(req: Request): Promise<AuthResult>;
  store: Store;
  now(): number;
  log(code: string): void;
  /** 单测替换；默认 randomToken */
  newToken?: () => string;
}

import { json } from '../_shared/http.ts';
export { json };
const err = (status: number, code: string) => json(status, { error: code });

// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function rateKey(userId: string, ms: number): string {
  return `token-admin:${userId}:${new Date(ms).toISOString().slice(0, 10).replace(/-/g, '')}`;
}

/** label：没给、空的当 null；坏字符回 'bad'；超长回 'too_long' */
export function cleanLabel(v: unknown): string | null | 'bad' | 'too_long' {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || BAD_CHARS.test(v)) return 'bad';
  const s = v.trim();
  if (s === '') return null;
  return [...s].length > LABEL_MAX ? 'too_long' : s;
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return err(405, 'method_not_allowed');
  const auth = await deps.authenticate(req);
  if (!auth.ok) return auth.response;
  const userId = auth.user.userId;

  let body: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return err(400, 'bad_request');
    body = JSON.parse(text);
  } catch {
    return err(400, 'bad_request');
  }
  const b = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  if (!b || b['action'] !== 'create') return err(400, 'bad_request');
  const label = cleanLabel(b['label']);
  if (label === 'bad') return err(400, 'bad_request');
  if (label === 'too_long') return err(400, 'label_too_long');

  try {
    if ((await deps.store.activeCount(userId, new Date(deps.now() - TOKEN_TTL_MS).toISOString())) >= MAX_ACTIVE) return err(409, 'too_many_tokens');
    if (!(await deps.store.takeRate(rateKey(userId, deps.now()), DAILY_LIMIT, 86400))) return err(429, 'rate_limited');
  } catch {
    deps.log('store:take_rate');
    return err(503, 'try_later');
  }
  for (let i = 0; i < INSERT_ATTEMPTS; i++) {
    const token = (deps.newToken ?? randomToken)();
    let r: { id: string; created_at: string } | 'duplicate';
    try {
      r = await deps.store.insertToken({ user_id: userId, label, token_hash: await tokenHash(token), scopes: ['create'] });
    } catch {
      deps.log('store:insert');
      return err(503, 'try_later');
    }
    if (r === 'duplicate') continue;
    const created = Date.parse(r.created_at);
    const expires = new Date((Number.isFinite(created) ? created : deps.now()) + TOKEN_TTL_MS).toISOString();
    return json(200, { token, id: r.id, expires_at: expires });
  }
  deps.log('token_collision');
  return err(503, 'try_later');
}
