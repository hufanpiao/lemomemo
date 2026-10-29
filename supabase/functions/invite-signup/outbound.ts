// invite-signup 的两个出站地址（Turnstile siteverify、Resend 发信）怎么取（接手清单 INVITE-mailpit，E2E-REAL ⑦ 的前置，10-30）。
// 纯函数，index.ts 按环境变量调；单测在 tests/functions/invite-signup-outbound.test.ts。不读环境变量、不 import npm 包。
//
// 变量：TURNSTILE_SITEVERIFY_URL、RESEND_EMAILS_URL。只给本机和 e2e 用（tools/e2e/real-backend.mjs 写进 lemo-e2e 的 functions/.env），
// 线上（正式、预览）一律不设——不设（undefined）或设成空串 '' 就用下面的官方地址，和加这两个变量之前完全一样；
// 设了但全是空白（'   '、制表符、换行）不算没设，任何环境都拒（D4，INVITE-sugg 10-30：多半是模板没填好，拒了才看得出来）。
// 防线上误配（选的是“直接拒”，不是“当没配”）：值不合规时 index.ts 把整个函数当没配好，回 500 misconfigured、日志只记 outbound_url_invalid，
// 不悄悄改用官方地址——误配一眼就能从冒烟测试看出来，不会带着错配置照常跑。合规的值只有两种：
//   ① 一字不差的官方地址（下面两个常量，https）；任何环境都认；
//   ② 本机回环地址：协议 http 或 https、主机正好是 127.0.0.1 或 localhost、不带用户名密码。只有本机环境（envKind = local）认；
//      正式、预览环境里写回环地址照样拒（线上主机上的 localhost 是平台自己的内部服务，不许把 secret、邮件往那儿发）。
//      主机要在原文里字面写成 127.0.0.1 或 localhost（D5，INVITE-sugg 10-30；localhost 不分大小写，LOCALHOST 照样认）：
//      URL 解析会把 127.1、2130706433、0x7f000001、全角数字、%31%32%37、末尾带点的 127.0.0.1. 都规范成 127.0.0.1，
//      这些写法只看解析结果会混过去，所以解析通过后再对原文查一遍。
//      注意：envKind 判成 local 的主机里有 kong（lemo-e2e 容器里 SUPABASE_URL 是 http://kong:8000），但出站地址写 kong 不认——
//      envKind 只决定“是不是本机环境”，出站回环只有 127.0.0.1 和 localhost 两个。
//      端口写成 0（:0、:00、:000）也拒：肯定连不上，是误配（INVITE-sugg 10-30）。
// 原文里只要有空白或控制字符（首尾、中间都算：空格、\t、\n、\r、全角空格 U+3000、不换行空格 NBSP、U+0000–U+001F、U+007F）一律拒，
//   不论官方地址还是回环地址、不论哪个环境（INVITE-sugg 10-30，主持人定的统一口径；全空白也在这条里拒）。
//   new URL 会悄悄去掉首尾空白、删掉中间的 \t \n \r，不拦的话 http://127.0.0.1:80\t81/x 这种会被解析成 8081 混过去。
// 官方地址只认一字不差：前后多空格、末尾带 \n / \r\n、大小写不同（HTTPS://api.resend.com/emails）都不算官方地址；
//   它们也不是回环地址，所以各个环境都拒（线上本来就不该设这两个变量，拒了才看得出模板没填好）。
// 其余一律拒：别的主机（含官方主机换了路径、多了斜杠）、localhost.example.com、带 user@、解析不了、别的协议、全空白。
// 返回值里的 overridden：true 表示换成了回环地址（不是官方地址）。index.ts 看到任一个为 true 就记一次日志 outbound_url_overridden
// （每个函数实例只记一次，只记日志码不记地址）。overridden 只有本机环境才可能是 true，所以 outbound_url_overridden 只会在本机出现，
// 用来确认本机确实换了地址；线上（正式、预览）配错时日志里出现的是 outbound_url_invalid，同时回 500，线上要看的是这一条。
import type { EnvKind } from '../_shared/env-kind.ts';

/** 官方地址（线上默认；改之前写死在 index.ts 里的就是这两个） */
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
export const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

/** 回环地址只认这两个主机名（不认 [::1]、127.0.0.2 之类；127.1 这种简写解析后虽然是 127.0.0.1，但原文不是字面写法，照样拒） */
export const LOOPBACK_HOSTS: readonly string[] = ['127.0.0.1', 'localhost'];

/** 原文的主机部分必须字面写成 127.0.0.1 或 localhost（不分大小写），后面紧跟端口、路径、查询、片段或结尾（D5） */
const LITERAL_LOOPBACK = /^https?:\/\/(?:127\.0\.0\.1|localhost)(?=[:/?#]|$)/i;

/** 有没有空白（\s：含全角空格 U+3000、NBSP 等 Unicode 空白）或控制字符（U+0000–U+001F、U+007F）。控制字符不写进正则，免得触发 eslint no-control-regex */
function hasSpaceOrControl(s: string): boolean {
  if (/\s/.test(s)) return true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

export type OutboundUrl = { ok: true; url: string; overridden: boolean } | { ok: false };

/**
 * 取一个出站地址。raw 是环境变量原值（没设是 undefined），official 是官方地址，env 是 envKind(SUPABASE_URL)。
 * 没设或空串 → 官方地址；任何位置有空白或控制字符（含首尾空白、全空白）→ {ok: false}；等于官方地址 → 官方地址；
 * 本机环境下、原文字面写 127.0.0.1 或 localhost 的回环地址 → 规范化后的这个地址（overridden: true）；其余 → {ok: false}
 */
export function resolveOutboundUrl(raw: string | undefined, official: string, env: EnvKind): OutboundUrl {
  if (raw === undefined || raw === '') return { ok: true, url: official, overridden: false };
  // 原文任何位置有空白或控制字符都拒（含首尾空白、全空白 D4）：new URL 会去掉首尾空白、删掉中间的 \t \n \r，不拦就会混过去（INVITE-sugg 10-30）
  if (hasSpaceOrControl(raw)) return { ok: false };
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
  // 解析通过后再查原文：127.1、2130706433、0x7f000001、全角、百分号编码、末尾带点这些解析后也是 127.0.0.1，原文不是字面写法就拒
  if (!LITERAL_LOOPBACK.test(raw)) return { ok: false };
  // 端口 0 肯定连不上，属于误配，拒（INVITE-sugg 10-30）。0 不是任何协议的默认端口，所以 :0、:00、:000 解析后 port 都是 '0'
  // （不会像 :80/:443 那样被规范成空串）；没写端口或写的是默认端口时 port 是 ''，照常放行
  if (u.port === '0') return { ok: false };
  return { ok: true, url: u.href, overridden: true };
}
