// 这次登录里 AI 能不能发（B3 前端接 ai-parse 安全审 S1；主持人 11-09 定方案 ①，安全复审两条建议）：
// • 告知页关口问到的结果记在这里（onboarding/hooks/useConsentWiring.ts 的 useNoticeState，关口超时以后才回来的结果也记）：
//   'first'、'updated' = 同意版本明确过期（还没同意过、看过的版本低于 min_consent_ver）→ 不发；'none' → 可以发
// • 告知页做完（onDone，服务器已记下当前版本）：同意 → 可以发；不同意 → 不发。真正挡住 AI 的是服务器：用户不同意时它清空同意时间、
//   关掉 ai.enabled；这里只是把 ai.enabled 同步回本机之前那段空档也关上
// • 打字条（plus/hooks/useTypeBar.ts）“不发”时不调 ai-parse，直接用本机规则；读失败、没问过（不知道）照常发，由服务器把关（consent_required）
// • 跟着登录走：记下时连同当时的会话 id（platform/session.ts 的 readSessionId）一起记，读时会话对不上（退出登录、换了账号）就当没记过，
//   不靠整页重载复位，也不用往首屏的退出流程里加东西。会话 id 由调用方传（kit/state 不引 platform，eslint boundaries）
// • features 之间不能互相 import，所以放在 kit；只有告知页、打字条两个懒加载块用，不进首屏
// 纯 TS
let mark: { sid: string | null; stale: boolean } | null = null;

/** 记下：true = 不发（同意版本明确过期，或刚点了不同意），false = 可以发 */
export function setConsentStale(v: boolean, sid: string | null): void {
  mark = { sid, stale: v };
}

/** 这次登录里明确不该发 AI（不知道、已退出、换了账号、会话 id 为空时是 false） */
export function consentStale(sid: string | null | undefined): boolean {
  // 会话 id 为空（''、null、undefined）一律当没记过（安全复核建议：两边都读失败为 null 时不算对得上）
  if (!sid) return false;
  return mark !== null && mark.sid === sid && mark.stale;
}
