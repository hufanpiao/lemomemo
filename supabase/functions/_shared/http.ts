// 服务器函数的 json 响应、定时任务密钥鉴权只在这里做（架构约定 10.1；出站超时在 net.ts）。
// 不变量：json 响应一律 no-store；不碰网络。
// 不 import npm 包、不读环境变量，Vitest 直接测。
import { safeEqual } from './proxy-headers.ts';

export const NO_STORE: Readonly<Record<string, string>> = { 'cache-control': 'no-store' };
/** CRON_SECRET、OPS_SECRET 至少 32 字节（UTF-8），短了按没配好处理 */
export const MIN_SECRET_BYTES = 32;

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8', ...NO_STORE } });
}

/**
 * 定时任务的密钥头（调用方自己写 req.headers.get('<头名>')，F9 按函数目录查头名）：先鉴权、再判没配好——
 * 没带对密钥的调用方看不出函数配没配。回 null 表示通过，否则是要直接回的响应
 */
export function cronGate(got: string | null, secret: string | undefined, log?: (code: string) => void): Response | null {
  const s = secret ?? '';
  if (s === '' || !got || !safeEqual(got, s)) return json(401, { error: 'unauthorized' });
  if (new TextEncoder().encode(s).length < MIN_SECRET_BYTES) {
    log?.('misconfigured:cron_secret');
    return json(500, { error: 'misconfigured' });
  }
  return null;
}
