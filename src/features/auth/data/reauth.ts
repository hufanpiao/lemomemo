// 登录页的“登录已过期”（R-382 架构 4.1a 第 2 点）：有 lemo.reauth 时登录页要用的几样东西，集中在这里（hooks/useReauth.ts 用）
// • read：读记号（platform/auth-loss-store.ts，过期、时间在未来 1 天以上都当没有）
// • count：本机 outbox 还有几条没发（platform/local-outbox.ts 的 localOutbox.count()）——登录页对本机库只有这一次计数调用，
//   不读 server、view，不读 outbox 条目的内容（0.59 安全审建议，单测钉住）
// • fate：登录页再查（联网时每打开一次查一次）：用记号里的 session_id、user_id 在本机算 pair_hash，调 session_fate；回 revoked 照 removed 清库
// • wipe：清库（platform/sign-out.ts 的 wipeThisDevice：按库名删 planner-v4、清运行时缓存、断开推送，同一步删 lemo.reauth），再清日志上传队列
// • clearAuthLoss：登录页“清除这台设备上的内容”是本人主动清除，lemo.authloss 一起删（0.59 M4）；再查回 revoked 是被动清库，不删
// 登录页不跑 boot、不 import core（会带进 zod），这里只用 platform
import { clearAuthLoss, readReauth, type Reauth } from '../../../platform/auth-loss-store.ts';
import { localOutbox } from '../../../platform/local-outbox.ts';
import { clearLogQueue } from '../../../platform/log-store.ts';
import { browserLifecycle } from '../../../platform/net.ts';
import { defaultExitSteps, wipeThisDevice } from '../../../platform/sign-out.ts';
import { querySessionFateResult, type SessionFateResult } from '../../../platform/supabase/session-fate.ts';
import { appFetch } from '../../../platform/http.ts';

export type { Reauth } from '../../../platform/auth-loss-store.ts';

export interface ReauthDeps {
  read(): Reauth | null;
  count(): Promise<number | null>;
  online(): boolean;
  onOnline(fn: () => void): () => void;
  /** 'retry'：在线但限流或服务器出错（429、5xx），过一会儿再查 */
  fate(sessionId: string, userId: string): Promise<SessionFateResult>;
  wipe(): Promise<void>;
  clearAuthLoss(): void;
}

export const defaultReauthDeps: ReauthDeps = {
  read: () => readReauth(),
  count: () => localOutbox.count(),
  online: () => browserLifecycle.isOnline(),
  onOnline: (fn) => browserLifecycle.onOnline(fn),
  fate: (sid, uid) => querySessionFateResult(sid, uid, { fetch: appFetch }),
  wipe: async () => {
    await wipeThisDevice(defaultExitSteps);
    clearLogQueue(null);   // 日志上传队列一起清（同 main.tsx 没有会话时的做法）
  },
  clearAuthLoss: () => clearAuthLoss(),
};
