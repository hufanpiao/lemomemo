// 登录页“退出并换账号”的本机一半（架构 4.1、0.38 第 35 条）
// 清本机库、Cache Storage、兜底删本机会话的几步已合并到 platform/sign-out.ts（和设置页共用，接手清单 K-signout-merge）：
// 登录页不跑 boot、不 import core（会带进 zod），不传 wipe，platform 按库名直接删 planner-v4。这里只留登录页自己要的读令牌
const SESSION_KEY_RE = /^sb-.+-auth-token$/;

/** 本机存着的 access token（只读 localStorage，不联网、不加载 supabase-js）；找本会话那一行 devices 用，没有为 null */
export function readStoredAccessToken(storage?: Storage): string | null {
  try {
    const s = storage ?? localStorage;
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i);
      if (!k || !SESSION_KEY_RE.test(k)) continue;
      const o = JSON.parse(s.getItem(k) ?? 'null') as { access_token?: unknown } | null;
      if (typeof o?.access_token === 'string' && o.access_token) return o.access_token;
    }
  } catch {
    // 同上
  }
  return null;
}
