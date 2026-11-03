// 本机推送替身的判断（B2 安全审查 1.5 第 ② 点 D1-8，取代 D1-S2）。push-dispatch（以及将来的 push-test）只经这里决定改不改投。
// 这是仓库里除 tests/ 外**唯一**允许出现 host.docker.internal 的文件（build/check_backend.py 的 F10 拦别处出现）。
//
// 判断“本机”必须同时满足两条，任何一条不满足（含 SUPABASE_URL 缺失、解析失败、开关不等于 1）都按线上处理：
//   ① new URL(SUPABASE_URL) 的协议是 http，主机名正好是 kong、127.0.0.1、localhost 之一
//      （线上 SUPABASE_URL 是平台注入的 https://<ref>.supabase.co，supabase secrets set 设不了 SUPABASE_ 开头的变量，伪造不了）；
//   ② LEMO_LOCAL_PUSH_STUB 等于 '1'（只写在 supabase/.env.local；发布脚本在预览、正式看到这个名字就失败，D1-S3）。
// 替身地址 PUSH_SERVICE_OVERRIDE_URL：
//   • 没设或空串 → 不改投；
//   • 线上（上面两条缺一）只要非空，不管值是什么 → {ok: false}（调用方验完 x-cron-secret 后回 500 misconfigured:override，一条不发）；
//   • 本机也要原串匹配 OVERRIDE，端口 1024～65535；不许用户名密码、查询串、#；不合格同样 {ok: false}。
// 改投以后：真实端点仍先过白名单（send.ts 的 deliver），真实端点一次都不连；VAPID 的 aud 仍按真实端点的 origin 签（替身据此核对 aud），
//   不签 aud = 替身地址的 JWT。
// 不 import npm 包、不碰 Deno 全局（环境变量由调用方读好传进来）；字符串字面量里不写 http(s):（deno-config 扫描），协议用 slice 比较。

const LOCAL_HOSTS: readonly string[] = ['kong', '127.0.0.1', 'localhost'];
/** 替身地址原串（1.5 第 ②，原样照抄） */
const OVERRIDE = /^http:\/\/(127\.0\.0\.1|localhost|host\.docker\.internal):([0-9]{4,5})(\/[A-Za-z0-9._~:/=&+-]*)?$/;

/** 两条都满足才是本机 */
export function isLocalStubEnv(supabaseUrl: string | undefined, stubFlag: string | undefined): boolean {
  if (stubFlag !== '1' || !supabaseUrl) return false;
  let u: URL;
  try {
    u = new URL(supabaseUrl);
  } catch {
    return false;
  }
  return u.protocol.slice(0, -1) === 'http' && LOCAL_HOSTS.includes(u.hostname);
}

export type Override = { ok: true; url: string | null } | { ok: false };

export function resolveOverride(raw: string | undefined, supabaseUrl: string | undefined, stubFlag: string | undefined): Override {
  if (raw === undefined || raw === '') return { ok: true, url: null };
  if (!isLocalStubEnv(supabaseUrl, stubFlag)) return { ok: false };
  const m = OVERRIDE.exec(raw);
  if (!m) return { ok: false };
  const port = Number(m[2]);
  if (!(port >= 1024 && port <= 65535)) return { ok: false };
  return { ok: true, url: raw };
}
