// 隐私说明版本号的比较，和“本机缓存里已经看过要求的版本了吗”。
// 冷启动联网时走告知页关口要等服务器回 profiles、app_config，回来以前什么也不画，切回 App 会先白屏一会儿。
// 缓存的 profile、config（同步引擎每次联网整行刷新，core/boot.ts）就能判定“已经看过”的，启动时不走关口、直接画 App（app/root.tsx）；
// 没看过、版本低于要求、认不出的照旧走关口问服务器。服务器抬高了要求的版本：这次用的是旧缓存、照常进 App，同步刷新缓存后下次冷启动出“隐私说明更新了”。
// 版本号写法和比较同 supabase/functions/_shared/consent.ts，features/onboarding/data/consent-api.ts 也用这一份

export const POLICY_VER_RE = /^\d{4}-\d{2}-\d{2}(-[1-9]\d?)?$/;

/** a 不低于 b；任何一个认不出都算否 */
export function policyVerAtLeast(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || !POLICY_VER_RE.test(a) || !POLICY_VER_RE.test(b)) return false;
  const pa = a.split('-').map(Number);
  const pb = b.split('-').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** 缓存的 profile、config 说明已经看过要求的隐私说明版本（要求的版本认不出当没有要求，同关口的判定）；本人版本没有、认不出都算没看过 */
export function seenNotice(profile: Record<string, unknown> | null, config: Record<string, unknown> | null): boolean {
  const mine = profile?.['consent_policy_ver'];
  if (typeof mine !== 'string' || !POLICY_VER_RE.test(mine)) return false;
  const notice = config?.['notice'];
  const min = typeof notice === 'object' && notice !== null ? (notice as Record<string, unknown>)['min_consent_ver'] : null;
  return typeof min !== 'string' || !POLICY_VER_RE.test(min) || policyVerAtLeast(mine, min);
}
