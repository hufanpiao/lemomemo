// 登录页的“登录已过期”状态（R-382 架构 4.1a 第 2 点）：数据都经 data/reauth.ts
// • 打开时读一次 lemo.reauth：没有 → none（登录页照旧）；有 → expired，数一次本机 outbox（只这一次计数调用），
//   联网时用记号查一次 session_fate（离线就等恢复联网再查一次）：回 revoked → 清库（wipe），状态改成 removed，提示“被移除”；
//   在线但回 429、5xx（限流、服务器出错）→ 30 秒起每次翻倍、最长 5 分钟，最多再查 FATE_RETRY_MAX 次；到点离线就照旧等联网（安全审建议 1）
// • clear()：登录页“不登录了，清除这台设备上的内容”：清库、删 lemo.reauth（wipe 里）、删 lemo.authloss → cleared
// • 状态是 expired、removed、cleared 时登录页不再显示 lemo.exit_notice 里那条（这里顺手删掉，免得以后冒出来）
// • 已停用只退出、不清本机（R-382 负责人 11-11 定）：记号在、且原因是 disabled → reason 'disabled'，
//   提示“账号已停用、已退出登录”，内容还在、可以清除；停用写的记号 session_id 为 null，不查 session_fate
// • 原因以记号里的 reason 为准（R-382 复核建议 ①）：退出原因只存 sessionStorage，下面一挂载就删，刷新登录页、iOS 杀掉重开都会丢；
//   sessionStorage 只当后备（旧记号没有 reason 时按 expired，这时 sessionStorage 记着 disabled 仍按停用）
import { useCallback, useEffect, useRef, useState } from 'react';
import { clearExitNotice, readExitNotice } from '../../../platform/session.ts';
import { defaultReauthDeps, type ReauthDeps } from '../data/reauth.ts';

export type ReauthView =
  | { kind: 'none' }
  | { kind: 'expired'; reason: 'expired' | 'disabled'; pending: number | null; busy: boolean }
  | { kind: 'removed' }
  | { kind: 'cleared' };

/** 登录页 session_fate 限流、5xx 时的重查：第一次等 30 秒，之后翻倍，最长 5 分钟，最多 5 次（30、60、120、240、300 秒） */
export const FATE_RETRY_BASE_MS = 30_000;
export const FATE_RETRY_CAP_MS = 300_000;
export const FATE_RETRY_MAX = 5;

export function useReauth(deps: ReauthDeps = defaultReauthDeps) {
  const [view, setView] = useState<ReauthView>(() => {
    try {
      const r = deps.read();
      if (!r) return { kind: 'none' };
      const disabled = r.reason === 'disabled' || readExitNotice() === 'disabled';
      return { kind: 'expired', reason: disabled ? 'disabled' : 'expired', pending: null, busy: false };
    } catch {
      return { kind: 'none' };
    }
  });
  const started = useRef(false);
  const wiping = useRef(false);

  /** 清库；removed：再查回 revoked（被动清库），否则是本人点了清除（连 lemo.authloss 一起删） */
  const wipe = useCallback(
    async (removed: boolean): Promise<void> => {
      if (wiping.current) return;
      wiping.current = true;
      setView((v) => (v.kind === 'expired' ? { ...v, busy: true } : v));
      try {
        await deps.wipe();
      } catch {
        // 清不掉的下次冷启动再清（记号已删就照旧删库）
      }
      if (!removed) {
        try {
          deps.clearAuthLoss();
        } catch {
          // 同上
        }
      }
      setView(removed ? { kind: 'removed' } : { kind: 'cleared' });
    },
    [deps],
  );

  useEffect(() => {
    if (started.current || view.kind !== 'expired') return;
    started.current = true;
    clearExitNotice();
    const r = deps.read();
    let off: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let alive = true;
    let tries = 0;
    void deps
      .count()
      .catch(() => null)
      .then((n) => setView((v) => (v.kind === 'expired' ? { ...v, pending: n } : v)));
    /** 联网就查，离线就等联网 */
    const whenOnline = (): void => {
      if (deps.online()) check();
      else off = deps.onOnline(check);
    };
    const check = (): void => {
      off?.();
      off = null;
      if (!r?.session_id) return;
      void deps
        .fate(r.session_id, r.user_id)
        .catch(() => null)
        .then((f) => {
          if (!alive) return;
          if (f === 'revoked') return void wipe(true);
          if (f !== 'retry' || tries >= FATE_RETRY_MAX) return;
          const wait = Math.min(FATE_RETRY_BASE_MS * 2 ** tries, FATE_RETRY_CAP_MS);
          tries += 1;
          timer = setTimeout(() => {
            timer = null;
            whenOnline();
          }, wait);
        });
    };
    if (r?.session_id) whenOnline();
    return () => {
      // 卸载（开发版 StrictMode 会先卸一次再挂）：放开监听和重查的定时器，重挂时再跑一遍（开发版会多数一次、多查一次，生产版只一次）
      started.current = false;
      alive = false;
      off?.();
      if (timer !== null) clearTimeout(timer);
    };
    // 只在打开时跑一次（started 管着），不随 view 变化重跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clear = useCallback(() => wipe(false), [wipe]);
  return { view, clear };
}
