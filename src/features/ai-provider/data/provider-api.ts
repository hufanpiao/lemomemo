// 调 ai-provider 函数（契约 shared/schema/ai-provider.ts，前后端共用一份）
// • 一律经 platform/fn-call.ts 的 callFn；请求体先按契约的 aiProviderReq 校验（校验不过不发，回 bad_input），响应按各动作的 zod 校验，认不出的当失败（bad_response）
// • 错误：服务器回 {error: 码}（invite-admin 同一写法），认得的码原样给出去（not_admin、not_tested、not_supported、no_key、rate_limited、try_later），
//   401 和 unauthorized、account_* 一类归 signed_out，其余归 failed；没登录 no_session → signed_out；超时 timeout；断网 network → offline
// • 密钥只在这一次请求体里，这里不记、不存、不进日志（运行日志由 hooks 记动作名和结果码）
// 纯 TS：不准 import React
import {
  AI_PROVIDER_ERROR_CODES, AI_PROVIDER_FN, adminGetRes, adminKeyRes, aiProviderReq, isWebKeyOwner, mineRes, okRes, ownUseRes, testRes,
  type AdminGetRes, type AiProviderErrorCode, type AiProviderReq, type AiRouteTask, type AiWebName, type KeyOwnerName, type MineRes, type TestFailCode, type TestRes,
} from '../../../../shared/schema/ai-provider.ts';
import type { z } from 'zod';
import { callFn, defaultFnDeps, type FnDeps } from '../../../platform/fn-call.ts';
import type { PickName } from './rules.ts';

/** 读（mine、admin_get）等 10 秒；试调、存、改用（服务器先试调最多 10 秒再存，多留）客户端等 25 秒（和服务器 ai-provider/core.ts 的试调超时 TEST_TIMEOUT_MS 不是一回事，名字分开） */
export const READ_TIMEOUT_MS = 10_000;
export const PROVIDER_CLIENT_TIMEOUT_MS = 25_000;

export type ProvErr = AiProviderErrorCode | 'offline' | 'timeout' | 'signed_out' | 'bad_input' | 'bad_response' | 'failed';
export type ProvResult<T> = { ok: true; value: T } | { ok: false; err: ProvErr };

const KNOWN: ReadonlySet<string> = new Set(AI_PROVIDER_ERROR_CODES);
const SIGNED_OUT: ReadonlySet<string> = new Set(['unauthorized', 'account_disabled', 'account_pending_deletion', 'session_revoked']);

/**
 * 写的几个动作（own_use、own_off、own_delete、admin_key、admin_route）的回包按契约逐个认（okRes、ownUseRes、adminKeyRes），认不出当 bad_response；
 * own_use、admin_key 先试再存，回的是试调不通的样子（{ok: false, code}）就当没通、带上原因。
 * 成功以后由 hooks 重读 mine / admin_get 拿服务器上的真样子
 */
export type WriteOut = { done: true } | { done: false; code: TestFailCode };
const asWrite = (v: { ok: true } | { ok: false; code: TestFailCode }): WriteOut => (v.ok ? { done: true } : { done: false, code: v.code });
const okWrite = okRes.transform(asWrite);
const ownUseWrite = ownUseRes.transform(asWrite);
const adminKeyWrite = adminKeyRes.transform(asWrite);

/** 服务器回的错误体 → 错误码 */
export function errOf(status: number, body: unknown): ProvErr {
  const code = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)['error'] : undefined;
  if (typeof code === 'string' && KNOWN.has(code)) return code as AiProviderErrorCode;
  if (status === 401 || (typeof code === 'string' && SIGNED_OUT.has(code))) return 'signed_out';
  return 'failed';
}

async function call<T>(req: AiProviderReq, res: z.ZodType<T>, timeoutMs: number, d: FnDeps, signal: AbortSignal): Promise<ProvResult<T>> {
  if (!aiProviderReq.safeParse(req).success) return { ok: false, err: 'bad_input' };
  const r = await callFn(AI_PROVIDER_FN, req, signal, timeoutMs, d);
  if (!r.ok) return { ok: false, err: r.code === 'no_session' ? 'signed_out' : r.code === 'timeout' ? 'timeout' : 'offline' };
  if (r.status < 200 || r.status >= 300) return { ok: false, err: errOf(r.status, r.body) };
  const p = res.safeParse(r.body);
  return p.success ? { ok: true, value: p.data } : { ok: false, err: 'bad_response' };
}

export interface ProvDeps {
  fn: FnDeps;
  signal?: AbortSignal;
}

const never = new AbortController().signal;
const dOf = (d?: Partial<ProvDeps>): { fn: FnDeps; signal: AbortSignal } => ({ fn: d?.fn ?? defaultFnDeps(), signal: d?.signal ?? never });

/** provider：四家 AI 服务商，或联网搜索的 Brave / Tavily / Naver（这三家没有模型名，model 不发） */
export interface KeyReq {
  provider: KeyOwnerName;
  model: string;
  /** 不带（或只有空白）= 用库里存着的那把 */
  key?: string;
}

/** 密钥前后空白去掉；空了就不带（用库里那把） */
const keyOf = (r: KeyReq): { key?: string } => {
  const k = r.key?.trim() ?? '';
  return k === '' ? {} : { key: k };
};
/**
 * KeyReq → 请求体：AI 服务商发 {action, provider, model, key?}；Brave / Tavily / Naver 发 {action: web 那一个, provider, key?}。
 * 我的 AI（own_*）只收四家：拿搜索那三家来调直接按 AI 服务商拼，契约校验不过，回 bad_input、不发
 */
function keyBody(ai: 'own_test' | 'own_use' | 'admin_test' | 'admin_key', web: 'admin_web_test' | 'admin_web_key' | null, r: KeyReq): AiProviderReq {
  if (isWebKeyOwner(r.provider) && web !== null) return { action: web, provider: r.provider, ...keyOf(r) };
  return { action: ai, provider: r.provider, model: r.model.trim(), ...keyOf(r) } as AiProviderReq;
}

export const readMine = (d?: Partial<ProvDeps>): Promise<ProvResult<MineRes>> => {
  const { fn, signal } = dOf(d);
  return call({ action: 'mine' }, mineRes, READ_TIMEOUT_MS, fn, signal);
};

export const ownTest = (r: KeyReq, d?: Partial<ProvDeps>): Promise<ProvResult<TestRes>> => {
  const { fn, signal } = dOf(d);
  return call(keyBody('own_test', null, r), testRes, PROVIDER_CLIENT_TIMEOUT_MS, fn, signal);
};

export const ownUse = (r: KeyReq, d?: Partial<ProvDeps>): Promise<ProvResult<WriteOut>> => {
  const { fn, signal } = dOf(d);
  return call(keyBody('own_use', null, r), ownUseWrite, PROVIDER_CLIENT_TIMEOUT_MS, fn, signal);
};

export const ownOff = (d?: Partial<ProvDeps>): Promise<ProvResult<WriteOut>> => {
  const { fn, signal } = dOf(d);
  return call({ action: 'own_off' }, okWrite, READ_TIMEOUT_MS, fn, signal);
};

export const ownDelete = (d?: Partial<ProvDeps>): Promise<ProvResult<WriteOut>> => {
  const { fn, signal } = dOf(d);
  return call({ action: 'own_delete' }, okWrite, READ_TIMEOUT_MS, fn, signal);
};

export const adminGet = (d?: Partial<ProvDeps>): Promise<ProvResult<AdminGetRes>> => {
  const { fn, signal } = dOf(d);
  return call({ action: 'admin_get' }, adminGetRes, READ_TIMEOUT_MS, fn, signal);
};

export const adminTest = (r: KeyReq, d?: Partial<ProvDeps>): Promise<ProvResult<TestRes>> => {
  const { fn, signal } = dOf(d);
  return call(keyBody('admin_test', 'admin_web_test', r), testRes, PROVIDER_CLIENT_TIMEOUT_MS, fn, signal);
};

export const adminKey = (r: KeyReq, d?: Partial<ProvDeps>): Promise<ProvResult<WriteOut>> => {
  const { fn, signal } = dOf(d);
  return call(keyBody('admin_key', 'admin_web_key', r), adminKeyWrite, PROVIDER_CLIENT_TIMEOUT_MS, fn, signal);
};

/** 三项 AI 用途某一项改由哪家做（admin_route，只收四家 AI 服务商）；对不上的契约校验不过，回 bad_input */
export const adminRoute = (task: AiRouteTask, provider: PickName, d?: Partial<ProvDeps>): Promise<ProvResult<WriteOut>> => {
  const { fn, signal } = dOf(d);
  return call({ action: 'admin_route', task, provider } as AiProviderReq, okWrite, READ_TIMEOUT_MS, fn, signal);
};

/** 联网搜索勾的几家（admin_web_route，各家各自打勾）；空的、有重复的、不是搜索四家的契约校验不过，回 bad_input */
export const adminWeb = (providers: readonly AiWebName[], d?: Partial<ProvDeps>): Promise<ProvResult<WriteOut>> => {
  const { fn, signal } = dOf(d);
  return call({ action: 'admin_web_route', providers: [...providers] }, okWrite, READ_TIMEOUT_MS, fn, signal);
};
