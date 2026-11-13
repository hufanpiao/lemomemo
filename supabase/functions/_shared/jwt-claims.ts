// JWT 的 payload（不验签名）：_shared/auth.ts（读 sub、session_id、amr）和 _shared/otp-fresh.ts（读 amr）共用这一份。
// 11-14 独立评审：原来两处各写一份、逐字相同，收到这里。只在调用方已经验过签名（requireActiveUser 的 getUser）以后用，不单独信任。
// 纯函数，不 import 任何东西，Vitest 直接测。

/** 解不开（不是三段、不是 base64url、不是 JSON 对象）一律回空对象 */
export function jwtClaims(jwt: string): Record<string, unknown> {
  try {
    const part = jwt.split('.')[1];
    if (!part) return {};
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const v: unknown = JSON.parse(atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '=')));
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
