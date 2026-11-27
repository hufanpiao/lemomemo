// invite-signup 的 store 调用一律带超时（接手清单 INVITE-store-timeout；通用部分在 _shared/store-timeout.ts）。
// 每个方法逐个写出来（不用方括号按名字取，check_backend F7）；返回值标成 Store，少包一个方法类型检查就报。
// Auth 管理接口的超时包装 withAuthTimeouts 也在这里（INVITE-auth-timeout）。
// 超时后各步怎么收尾见 core.ts：start 在知道码有没有效之前超时回 try_later（和码无关）；知道码有效之后（全站额度、写 pending）
//   超时或出错照样回 {ok}，和码无效一样，不泄露码有没有效。verify 的超时一律 try_later（验证码对了才会走到占码）。
import { storeTimer, type StoreTimeoutOpts } from '../_shared/store-timeout.ts';
import type { AuthAdmin, Store } from './types.ts';

/**
 * 一次请求里所有 store、Auth 调用合起来的预算（代码审查 (a)）：100 秒。index.ts 在请求一进来就记截止时刻，两个包装共用，
 * 每次调用的超时取 min(10 秒, 剩余)，没有剩余直接 try_later。verify 每一步都慢到将近 10 秒时，原来最坏约 151.5 秒，
 * 超过 Edge 150 秒墙钟；现在最坏约 100 秒加上自身计算，留出 50 秒给 Turnstile、发信以外的余量（start 一并适用，Turnstile、发信各有 8 秒超时，不占这份预算）
 */
export const REQUEST_BUDGET_MS = 100_000;

export function withStoreTimeouts(make: (signal: AbortSignal) => Store, opts: StoreTimeoutOpts = {}): Store {
  const t = storeTimer(make, opts);
  return {
    takeRate: (k, l, w) => t('takeRate', (s) => s.takeRate(k, l, w)),
    getInvite: (h) => t('getInvite', (s) => s.getInvite(h)),
    claimInvite: (eh, oh, h, at) => t('claimInvite', (s) => s.claimInvite(eh, oh, h, at)),
    releaseInvite: (eh, h) => t('releaseInvite', (s) => s.releaseInvite(eh, h)),
    putPending: (eh, row) => t('putPending', (s) => s.putPending(eh, row)),
    getPending: (eh) => t('getPending', (s) => s.getPending(eh)),
    casPendingTries: (eh, from, to, oh) => t('casPendingTries', (s) => s.casPendingTries(eh, from, to, oh)),
    deletePending: (eh, oh) => t('deletePending', (s) => s.deletePending(eh, oh)),
    insertProfile: (u, l) => t('insertProfile', (s) => s.insertProfile(u, l)),
    minClientVersion: () => t('minClientVersion', (s) => s.minClientVersion()),
  };
}

/**
 * Auth 管理接口也套超时（INVITE-auth-timeout；默认 10 秒，日志 auth_timeout:<方法名>）。supabase-js 的 auth.admin 不收 signal，
 * 中止不了底下的请求，只是不再等：createUser 超时可能晚到建出来，core 按派生的 id 查一次再定（createOrAdopt）；
 * deleteUser 超时按没删成处理（不退码，重试时认领），它也可能晚到删成——core 只对这一次刚建出来的半成品调 deleteUser（安全审查 N1），
 *   晚到删成也只删到它；magiclinkTokenHash 超时按失败处理（link_failed，客户端改走发登录验证码）
 */
export function withAuthTimeouts(auth: AuthAdmin, opts: StoreTimeoutOpts = {}): AuthAdmin {
  const t = storeTimer(() => auth, { ...opts, prefix: 'auth_timeout' });
  return {
    createUser: (id, email, locale) => t('createUser', (a) => a.createUser(id, email, locale)),
    userExists: (id) => t('userExists', (a) => a.userExists(id)),
    deleteUser: (id) => t('deleteUser', (a) => a.deleteUser(id)),
    magiclinkTokenHash: (email) => t('magiclinkTokenHash', (a) => a.magiclinkTokenHash(email)),
  };
}
