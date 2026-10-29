// invite-signup 的两个出站地址（Turnstile siteverify、Resend 发信）怎么取（接手清单 INVITE-mailpit，E2E-REAL ⑦ 的前置，10-30）。
// 纯函数，index.ts 按环境变量调；单测在 tests/functions/invite-signup-outbound.test.ts。不读环境变量、不 import npm 包。
//
// 变量：TURNSTILE_SITEVERIFY_URL、RESEND_EMAILS_URL。只给本机和 e2e 用（tools/e2e/real-backend.mjs 写进 lemo-e2e 的 functions/.env），
// 线上（正式、预览）一律不设——不设（或设成空串）就用下面的官方地址，和加这两个变量之前完全一样。
// 防线上误配（选的是“直接拒”，不是“当没配”）：值不合规时 index.ts 把整个函数当没配好，回 500 misconfigured、日志只记 outbound_url_invalid，
// 不悄悄改用官方地址——误配一眼就能从冒烟测试看出来，不会带着错配置照常跑。合规的值只有两种：
//   ① 一字不差的官方地址（下面两个常量，https）；任何环境都认；
//   ② 本机回环地址：协议 http 或 https、主机正好是 127.0.0.1 或 localhost、不带用户名密码。只有本机环境（envKind = local）认；
//      正式、预览环境里写回环地址照样拒（线上主机上的 localhost 是平台自己的内部服务，不许把 secret、邮件往那儿发）。
// 其余一律拒：别的主机（含官方主机换了路径、多了斜杠）、localhost.example.com、带 user@、解析不了、别的协议。
import type { EnvKind } from '../_shared/env-kind.ts';

/** 官方地址（线上默认；改之前写死在 index.ts 里的就是这两个） */
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

/** 回环地址只认这两个主机名（不认 [::1]、127.0.0.2 之类；URL 解析后 127.1 这种简写会规范成 127.0.0.1） */
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'];

export type OutboundUrl = { ok: true; url: string; overridden: boolean } | { ok: false };

/**
 * 取一个出站地址。raw 是环境变量原值（没设是 undefined），official 是官方地址，env 是 envKind(SUPABASE_URL)。
 * 没设或空串 → 官方地址；等于官方地址 → 官方地址；本机环境下的回环地址 → 规范化后的这个地址；其余 → {ok: false}
 */
export function resolveOutboundUrl(raw: string | undefined, official: string, env: EnvKind): OutboundUrl {
  if (raw === undefined || raw.trim() === '') return { ok: true, url: official, overridden: false };
  if (raw === official) return { ok: true, url: official, overridden: false };
  if (env !== 'local') return { ok: false };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false };
  }
  // 协议只比 "http" / "https" 两个词（不写带冒号的字面量：deno-config 的扫描把字符串里的 http(s): 当远程模块）
  const scheme = u.protocol.slice(0, -1);
  if (scheme !== 'http' && scheme !== 'https') return { ok: false };
  if (u.username !== '' || u.password !== '') return { ok: false };
  if (!LOOPBACK_HOSTS.includes(u.hostname.toLowerCase())) return { ok: false };
  return { ok: true, url: u.href, overridden: true };
}
