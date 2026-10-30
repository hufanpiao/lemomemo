// invite-signup 的 store 调用一律带超时（接手清单 INVITE-store-timeout；通用部分在 _shared/store-timeout.ts）。
// 每个方法逐个写出来（不用方括号按名字取，check_backend F7）；返回值标成 Store，少包一个方法类型检查就报。
// 超时后各步怎么收尾见 core.ts：start 在知道码有没有效之前超时回 try_later（和码无关）；知道码有效之后（全站额度、写 pending）
//   超时或出错照样回 {ok}，和码无效一样，不泄露码有没有效。verify 的超时一律 try_later（验证码对了才会走到占码）。
import { storeTimer, type StoreTimeoutOpts } from '../_shared/store-timeout.ts';
import type { Store } from './types.ts';

export function withStoreTimeouts(make: (signal: AbortSignal) => Store, opts: StoreTimeoutOpts = {}): Store {
  const t = storeTimer(make, opts);
  return {
    takeRate: (k, l, w) => t('takeRate', (s) => s.takeRate(k, l, w)),
    getInvite: (h) => t('getInvite', (s) => s.getInvite(h)),
    casInviteUsed: (h, from, to, at) => t('casInviteUsed', (s) => s.casInviteUsed(h, from, to, at)),
    putPending: (eh, row) => t('putPending', (s) => s.putPending(eh, row)),
    getPending: (eh) => t('getPending', (s) => s.getPending(eh)),
    casPendingTries: (eh, from, to, oh) => t('casPendingTries', (s) => s.casPendingTries(eh, from, to, oh)),
    deletePending: (eh, oh) => t('deletePending', (s) => s.deletePending(eh, oh)),
    insertProfile: (u, l) => t('insertProfile', (s) => s.insertProfile(u, l)),
    minClientVersion: () => t('minClientVersion', (s) => s.minClientVersion()),
  };
}
