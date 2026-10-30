// invite-admin 的 store 调用一律带超时（接手清单 INVITE-store-timeout；通用部分在 _shared/store-timeout.ts）。
// 每个方法逐个写出来（不用方括号按名字取，check_backend F7）；返回值标成 InviteStore，少包一个方法类型检查就报。
// 超时一律 try_later（core.ts handle 的 catch）。insertInvite 超时而语句晚到提交：库里多一个只有哈希、谁也不知道明文的码，
//   用不上，7 天后过期；takeRate 晚到提交只是当天多算一次。
import { storeTimer, type StoreTimeoutOpts } from '../_shared/store-timeout.ts';
import type { InviteStore } from './core.ts';

export function withStoreTimeouts(make: (signal: AbortSignal) => InviteStore, opts: StoreTimeoutOpts = {}): InviteStore {
  const t = storeTimer(make, opts);
  return {
    isAdmin: (u) => t('isAdmin', (s) => s.isAdmin(u)),
    takeRate: (k, l, w) => t('takeRate', (s) => s.takeRate(k, l, w)),
    insertInvite: (row) => t('insertInvite', (s) => s.insertInvite(row)),
    listInvites: (by, at, limit) => t('listInvites', (s) => s.listInvites(by, at, limit)),
    minClientVersion: () => t('minClientVersion', (s) => s.minClientVersion()),
  };
}
