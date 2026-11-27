// 这个账号能不能用 #2：读 my_ai_usage 的 ai_unlimited（服务器看 private.admins）。读不到一律先当不是管理员
// 真正的门在服务器：私有桶的 RLS 只放管理员，这里只决定显示什么
// • 整个 App 一份（useSyncExternalStore）：今天页、设置页、署名读的是同一个答案，答案变了一起更新
// • 冷启动 2 秒还没答：先按普通账号显示（今天页挂 Aldo）；之后读到是管理员，今天页、设置页一起换成 #2
// • 读不到（离线、超时）不推翻上次的答案，过一会儿再问（ADMIN_RETRY_MS），不会“这次打开就不再问”
// • 问到哪了记在这次打开的会话对象（mascot-session.ts 的 admin），只在内存：二级页回今天页重新挂上时不再从“不知道”起
import { useEffect, useState, useSyncExternalStore } from 'react';
import { readAiUsage } from '../../../platform/ai-usage.ts';
import { readPrivateCredit, type PrivateCredit } from '../data/mascot-private.ts';
import { mascotSession } from './mascot-session.ts';

/** 吉祥物不值得让今天页多等：这么久还没答就先按普通账号显示 */
export const ADMIN_WAIT_MS = 2000;
/** 读不到时隔多久再问（依次），问完这几次就等下一个用到的地方挂上再问 */
export const ADMIN_RETRY_MS: readonly number[] = [5000, 15_000, 60_000];

const listeners = new Set<() => void>();

/** 界面用的值：null = 还在等（最多 ADMIN_WAIT_MS），之后没答就是 false */
const value = (): boolean | null => mascotSession.admin.answer ?? (mascotSession.admin.waited ? false : null);
const emit = (): void => {
  for (const l of listeners) l();
};

function ask(): void {
  const s = mascotSession.admin;
  if (s.asking) return;
  s.asking = true;
  clearTimeout(s.retryT);
  s.retryT = undefined;
  if (!s.waited && s.waitT === undefined) {
    s.waitT = setTimeout(() => {
      s.waited = true;
      if (s === mascotSession.admin) emit();
    }, ADMIN_WAIT_MS);
  }
  void readAiUsage()
    .catch(() => null)
    .then((r) => {
      s.asking = false;
      if (s !== mascotSession.admin) return;
      if (r?.ok) {
        s.answer = r.value.unlimited;
        s.tries = 0;
        emit();
        return;
      }
      const wait = ADMIN_RETRY_MS[s.tries];
      s.tries += 1;
      if (wait !== undefined) s.retryT = setTimeout(ask, wait);
    });
}

const subscribe = (l: () => void): (() => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** null = 还在等；need 为 false 时不发请求（答案照样跟着别处的更新）。每次挂上都在后台再核一次 */
export function useMascotAdmin(need = true): boolean | null {
  const admin = useSyncExternalStore(subscribe, value, value);
  useEffect(() => {
    if (need) ask();
  }, [need]);
  return admin;
}

export function usePrivateCredit(): PrivateCredit | null {
  const admin = useMascotAdmin();
  const [credit, setCredit] = useState<PrivateCredit | null>(null);
  useEffect(() => {
    if (admin !== true) return;
    let live = true;
    void readPrivateCredit()
      .catch(() => null)
      .then((c) => {
        if (live) setCredit(c);
      });
    return () => {
      live = false;
    };
  }, [admin]);
  return admin === true ? credit : null;
}
