// ai-memory：“记住的事”页面的后端（R-495 AI 助手第 3 段）：看、删、撤销、全部清空。纯逻辑，依赖由 index.ts 注入，Vitest 直接测（tests/edge/ai-memory.test.ts）。
// 顺序：只收 POST → requireActiveUser（JWT）→ 请求体 ≤ MAX_BODY、过 shared/schema/ai-memory.ts 的 memoryReq → 每人每分钟 RATE_PER_MIN 次 → 经 fn_ai 读写本人的行。
// 不查 AI 同意：关了 AI、撤回同意的人也要能看和删自己的记忆。不调任何 AI 服务商，不扣 AI 次数。
// 日志只记动作和结果码，不记记忆内容、id（A23）。
import type { AuthResult } from '../_shared/auth-result.ts';
import { readJsonCapped } from '../_shared/body.ts';
import { json } from '../_shared/http.ts';
import { utcMinuteKey } from '../_shared/rate-key.ts';

export const MAX_BODY = 1024;
/** 写操作（删、撤销、清空）每人每分钟几次 */
export const RATE_PER_MIN = 30;
/** 读列表单独算：一页 50 条，翻到 5000 条要 100 次，不能和写操作抢 */
export const LIST_RATE_PER_MIN = 120;

export type Req = { action: 'list'; cursor?: string | undefined } | { action: 'clear' } | { action: 'delete'; id: string } | { action: 'undo'; id: string; replaced?: string | undefined };

export interface Deps {
  authenticate(req: Request): Promise<AuthResult<{ userId: string }>>;
  /** shared/schema/ai-memory.ts 的 memoryReq（不合格为 null） */
  parse(v: unknown): Req | null;
  rate(key: string, limit: number, windowS: number): Promise<boolean>;
  list(uid: string, cursor: string | null): Promise<{ items: { id: string; text: string; at: number }[]; next: string | null; total: number }>;
  remove(uid: string, id: string, now: number): Promise<boolean>;
  undo(uid: string, id: string): Promise<boolean>;
  /** 撤销一次改写：新行软删、旧行恢复 */
  undoReplace(uid: string, id: string, replaced: string, now: number): Promise<boolean>;
  clear(uid: string): Promise<void>;
  now(): number;
  log(code: string): void;
}

async function run(deps: Deps, uid: string, body: Req): Promise<Response> {
  switch (body.action) {
    case 'list': {
      const page = await deps.list(uid, body.cursor ?? null);
      deps.log(`list n=${page.items.length} total=${page.total} more=${page.next === null ? 0 : 1}`);
      return json(200, page);
    }
    case 'delete': {
      const ok = await deps.remove(uid, body.id, deps.now());
      deps.log(`delete ok=${ok ? 1 : 0}`);
      return json(200, { ok });
    }
    case 'undo': {
      const ok = body.replaced === undefined ? await deps.undo(uid, body.id) : await deps.undoReplace(uid, body.id, body.replaced, deps.now());
      deps.log(`undo ok=${ok ? 1 : 0}`);
      return json(200, { ok });
    }
    case 'clear':
      await deps.clear(uid);
      deps.log('clear');
      return json(200, { ok: true });
  }
}

export async function handle(req: Request, deps: Deps): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const auth = await deps.authenticate(req);
  if (!auth.ok) return auth.response;
  const uid = auth.user.userId;
  const raw = await readJsonCapped(req, MAX_BODY);
  if (raw === 'too_large') return json(413, { error: 'too_large' });
  const body = deps.parse(raw);
  if (!body) return json(400, { error: 'bad_request' });
  try {
    const [scope, limit] = body.action === 'list' ? ['ai-memory-list', LIST_RATE_PER_MIN] as const : ['ai-memory', RATE_PER_MIN] as const;
    if (!(await deps.rate(utcMinuteKey(scope, uid, deps.now()), limit, 60))) return json(429, { error: 'rate_limited' });
    return await run(deps, uid, body);
  } catch {
    deps.log(`${body.action} try_later`);
    return json(503, { error: 'try_later' });
  }
}
