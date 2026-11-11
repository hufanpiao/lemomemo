// ai-parse（架构第 6 节函数表 ai-parse 行、第 7 节、5.1；B3 任务单 S8、S12、S15、BE-4，Q2：服务器包 intent）。
// 顺序：方法（只收 POST）→ JWT（requireActiveUser，index.ts 注入成 authenticate）→ 请求体（default_day 不合格回 400，R6）→ 共用的门（_shared/ai/gate.ts：
// 同意、类型开关、模型配置、每分钟 6 次、谷歌额度、每人每天和全项目预扣）→ parseWithAI → 成功回
// {intent: 'record', confidence, items, quota_left}；失败退回预扣、回 {fallback, reason}（客户端改用本机规则，原话不丢）。
// 版本门在 index.ts 入口处查（不在免查名单，fn-version-gate 标“查”）。
// scope = vault：隐私记页面经“＋”记下在 B4b-3 才有（届时换成 verifyVaultToken + ai.vault），B3 一律回 {fallback, vault_ai_off}、不调 Gemini、不扣次数。
// 不 console.* 请求体（A23）；日志只记错误码。纯逻辑：依赖全部注入，不 import _shared/gen/、npm 包。
import { aiGate, settleFailure, type GateDeps } from '../_shared/ai/gate.ts';
import type { AIProvider } from '../_shared/ai/provider.ts';
import type { AiKindLike, ParseFail, ParseInput, ParseOk } from '../_shared/ai/parse-core.ts';
import { readJsonCapped } from '../_shared/body.ts';

/** 请求体上限（2000 字的中文 UTF-8 约 6 KB，加上 projects） */
export const MAX_BODY = 16 * 1024;
export const RECORD_CONFIDENCE = 1;

export type AuthResult = { ok: true; user: { userId: string } } | { ok: false; response: Response };

/** shared/schema/ai.ts 里入参相关的几个函数（index.ts 从 _shared/gen/ 注入，单测注入真的 shared） */
export interface Logic<Item> {
  parseRequest(body: unknown): { ok: true; value: { text: string; now: number; tz: string; locale?: string | undefined; projects?: unknown[] | undefined; scope?: 'main' | 'vault' | undefined; default_day?: string | undefined } } | { ok: false };
  normLocale(v: unknown): 'zh' | 'ko';
  normProjects(v: unknown): string[];
  isValidTz(tz: string): boolean;
  /** 默认日子（R6）：不传 null；格式不对、不存在、不在前 1 年到后 5 年之内 'bad' */
  checkDefaultDay(v: unknown, now: number, tz: string): string | null | 'bad';
  parseWithAI(input: ParseInput, provider: AIProvider): Promise<ParseOk<{ items: Item[] }> | ParseFail>;
}

export interface Deps<Item> extends GateDeps {
  authenticate(req: Request): Promise<AuthResult>;
  logic: Logic<Item>;
}

import { json } from '../_shared/http.ts';
export { json };

export async function handle<Item>(req: Request, deps: Deps<Item>): Promise<Response> {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
  const auth = await deps.authenticate(req);
  if (!auth.ok) return auth.response;
  const userId = auth.user.userId;

  const raw = await readJsonCapped(req, MAX_BODY);   // 边读边计数（安全审建议 1）
  if (raw === 'too_large') return json(413, { error: 'too_large' });
  const p = deps.logic.parseRequest(raw);
  if (!p.ok || !deps.logic.isValidTz(p.value.tz)) return json(400, { error: 'bad_request' });
  const body = p.value;
  const defaultDay = deps.logic.checkDefaultDay(body.default_day, body.now, body.tz);
  if (defaultDay === 'bad') return json(400, { error: 'bad_request' });
  if (body.scope === 'vault') return json(200, { fallback: true, reason: 'vault_ai_off' });

  const gate = await aiGate(deps, userId, req.headers.get('x-app-version') ?? '');
  if (gate.stop) return json(gate.status, gate.body);

  const input: ParseInput = {
    text: body.text, now: body.now, tz: body.tz, locale: deps.logic.normLocale(body.locale),
    projects: deps.logic.normProjects(body.projects), features: gate.features as AiKindLike[], defaultDay: defaultDay ?? undefined,
  };
  let r: ParseOk<{ items: Item[] }> | ParseFail;
  try {
    r = await deps.logic.parseWithAI(input, gate.provider);
  } catch {
    r = { ok: false, reason: 'error' };
  }
  if (r.badDefaultDay) deps.log('bad_default_day');   // R10 兜底：入口已 400，到这里说明入口漏校验
  if (!r.ok) {
    deps.log(`ai_${r.reason}`);
    await settleFailure(deps, gate, userId, 'ai-parse', r);
    return json(200, { fallback: true, reason: r.reason });
  }
  return json(200, { intent: 'record', confidence: RECORD_CONFIDENCE, items: r.value.items, quota_left: gate.quotaLeft });
}
