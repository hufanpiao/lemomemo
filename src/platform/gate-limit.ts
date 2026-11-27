// 告知页关口的时限和“还剩多久”：app/root.tsx 的 GatedApp、features/onboarding 的关口共用这一份。
// 放在 platform：features 不能引 app，两边都能引 platform；只有常量和一行算术，不碰 DOM、不引别的模块

/** 关口最多空白多久：从 GatedApp 挂上算起（含关口分包的加载时间）；比 noticeState 自己的 CONSENT_SLOW_MS 短 */
export const GATE_LIMIT_MS = 5000;

/** 从 since（Date.now() 的毫秒数）起、上限 limitMs，现在还剩多少毫秒；已经过了是 0 */
export const msLeft = (limitMs: number, since: number): number => Math.max(0, limitMs - (Date.now() - since));
