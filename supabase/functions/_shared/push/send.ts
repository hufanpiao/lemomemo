// 发一条 Web Push：校验 → 加密 → 签 VAPID → fetch → 按状态归类。push-dispatch、push-test 共用（B2 安全审查第五节第 4～8 条，D1-4、D1-S2）。
//   • 发送前再按白名单查一次端点和密钥（endpoint.ts；不合格不发，结果 bad_endpoint / bad_keys，调用方把这一行三列置空、记 push_bad_endpoint）；
//   • 原样用通过校验的字符串 fetch；redirect: 'manual'，opaqueredirect、状态 0、3xx 都算失败，不读、不记 Location；
//     每个请求 5 秒超时（经 _shared/net.ts 的 timedFetch）；响应体最多读 1 KB 就 cancel；不带 Cookie（credentials: 'omit'），除 VAPID 外不带别的凭据；
//   • 归类只给枚举（日志、push-test 的返回值都只用它，不回状态码、响应头、响应体、耗时，D1-5）：
//       ok（2xx）、gone（404、410：调用方删订阅）、vapid_rejected（401、403：只加 push_fail_count、不删订阅，R-282 ②）、
//       too_large（413）、rate_limited（429）、redirect（3xx 等）、timeout、network、failed（其余）。
//   • 本机替身（PUSH_SERVICE_OVERRIDE_URL，D1-8）：先照常按白名单查库里的端点，通过了才改投到替身，真实端点一次都不连；
//     JWT 的 aud 仍按真实端点的 origin 签（1.5 第 ②）。替身地址怎么认在 stub.ts（本机两条都满足才认；线上设了就是配错）。
// 不 import npm 包、不碰 Deno 全局；fetch 由调用方注入（测试替换）。

import type { Bytes } from '../b64url.ts';
import { checkEndpoint, checkKeys, type EndpointReason } from './endpoint.ts';
import { encryptPush, PushCryptoError } from './ece.ts';
import type { VapidSigner } from './vapid.ts';
import { timedFetch } from '../net.ts';

export const SEND_TIMEOUT_MS = 5000;
export const MAX_RESPONSE_BYTES = 1024;

export type SendOutcome = 'ok' | 'gone' | 'vapid_rejected' | 'too_large' | 'rate_limited' | 'redirect' | 'timeout' | 'network' | 'failed';
export type DeliverResult =
  | { outcome: SendOutcome }
  | { outcome: 'bad_endpoint'; reason: EndpointReason }
  | { outcome: 'bad_keys' }
  | { outcome: 'payload_too_large' };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export function classify(status: number, type: string): SendOutcome {
  if (type === 'opaqueredirect' || status === 0 || (status >= 300 && status < 400)) return 'redirect';
  if (status >= 200 && status < 300) return 'ok';
  if (status === 404 || status === 410) return 'gone';
  if (status === 401 || status === 403) return 'vapid_rejected';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  return 'failed';
}

/**
 * 响应体读到超过 MAX_RESPONSE_BYTES 字节的那一块为止，然后 cancel（内容丢掉，不记录）。按块读：最后那一块可能本身就超过 1 KB
 * （Deno 一块最多约 64 KB），所以实际最多多读一块；块的大小有网络缓冲兜着，内存有上限（BE1-S4、代码审查 S4）
 */
async function drain(r: Response): Promise<void> {
  const body = r.body;
  if (!body) return;
  const reader = body.getReader();
  let n = 0;
  try {
    while (n < MAX_RESPONSE_BYTES) {
      const { done, value } = await reader.read();
      if (done) return;
      n += value?.length ?? 0;
    }
  } catch {
    // 读不下去就算了
  } finally {
    await reader.cancel().catch(() => {});
  }
}

export type PushOptions = { ttl: number; urgency: 'very-low' | 'low' | 'normal' | 'high'; topic?: string };

/** RFC 8030 第 5.4 节：Topic 最多 32 个 base64url 字符（代码审查 S11） */
const TOPIC = /^[A-Za-z0-9_-]{1,32}$/;

/** 发出一个已加密的正文。url 必须是通过校验的原串（或已认可的替身地址） */
export async function postPush(fetchImpl: FetchLike, url: string, authorization: string, body: Bytes, opt: PushOptions): Promise<SendOutcome> {
  const headers: Record<string, string> = {
    authorization,
    'content-encoding': 'aes128gcm',
    'content-type': 'application/octet-stream',
    ttl: String(Math.max(0, Math.floor(opt.ttl))),
    urgency: opt.urgency,
  };
  if (opt.topic !== undefined) {
    // 不合格的 topic 是调用方的 bug：不发，按 failed 记（不让推送服务回 400，也不把怪值放进请求头）
    if (!TOPIC.test(opt.topic)) return 'failed';
    headers.topic = opt.topic;
  }
  let r: Response;
  try {
    r = await timedFetch(fetchImpl, SEND_TIMEOUT_MS)(url, { method: 'POST', redirect: 'manual', credentials: 'omit', headers, body });
  } catch (e) {
    const name = (e as { name?: unknown })?.name;
    return name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
  }
  const outcome = classify(r.status, r.type);
  await drain(r);
  return outcome;
}

// 本机替身怎么认在 stub.ts（D1-8）；这里只拿它给的地址（null 表示不改投）

export type Device = { push_endpoint: string | null; p256dh: string | null; auth: string | null };
export type DeliverCtx = { fetch: FetchLike; signer: VapidSigner; override: string | null };

/** 给一台设备发一条：先校验（替身模式也查），再加密、签名、发送。各步出错只影响这一条（C-10） */
export async function deliver(dev: Device, payload: Bytes, opt: PushOptions, ctx: DeliverCtx): Promise<DeliverResult> {
  const ep = checkEndpoint(dev.push_endpoint);
  if (!ep.ok) return { outcome: 'bad_endpoint', reason: ep.reason };
  const keys = checkKeys(dev.p256dh, dev.auth);
  if (!keys.ok) return { outcome: 'bad_keys' };
  let body: Bytes;
  try {
    body = await encryptPush(keys.uaPublic, keys.authSecret, payload);
  } catch (e) {
    if (e instanceof PushCryptoError) return { outcome: e.code };
    return { outcome: 'failed' };
  }
  const target = ctx.override ?? ep.url;   // 改投替身时真实端点一次都不连
  let authorization: string;
  try {
    authorization = await ctx.signer.authorization(ep.origin);   // aud 一律按真实端点的 origin（1.5 第 ②），替身据此核对
  } catch {
    return { outcome: 'failed' };
  }
  return { outcome: await postPush(ctx.fetch, target, authorization, body, opt) };
}
