// Turnstile 小窗（15.2 中 1 ①）：挂在 ref 指向的元素里，拿到令牌就存起来；令牌只能用一次，提交以后 take() 拿走并重置
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { mountTurnstile, type TurnstileWidget } from '../../../platform/turnstile.ts';
import { useUi } from '../../../kit/state/ui-store.ts';

export interface Captcha {
  /** 现在手上有没有可用的令牌 */
  ready: boolean;
  /** 脚本加载失败（网络、被拦） */
  failed: boolean;
  /** 拿走令牌（只能用一次），同时让小窗重新出一个 */
  take(): string | null;
}

/** Turnstile 的 action（安全审查 10）：登录和邀请注册分开；邀请注册的令牌只给 start 用，按架构 0.38 第 30 条叫 invite_start（服务器核对） */
export type TurnstileAction = 'login' | 'invite_start';

export function useTurnstile(ref: RefObject<HTMLElement | null>, enabled = true, action: TurnstileAction = 'login'): Captcha {
  const locale = useUi((s) => s.locale);
  const token = useRef<string | null>(null);
  const widget = useRef<TurnstileWidget | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return undefined;
    let cancelled = false;
    // 换 action 时整个小窗重画，旧令牌作废
    token.current = null;
    setReady(false);
    mountTurnstile(el, {
      language: locale === 'ko-KR' ? 'ko' : 'zh-cn',
      action,
      callback: (t) => {
        token.current = t;
        setReady(true);
      },
      'expired-callback': () => {
        token.current = null;
        setReady(false);
      },
      'error-callback': () => {
        token.current = null;
        setReady(false);
      },
    })
      .then((w) => {
        if (cancelled) w.remove();
        else widget.current = w;
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      widget.current?.remove();
      widget.current = null;
      token.current = null;
    };
  }, [ref, enabled, locale, action]);

  const take = useCallback((): string | null => {
    const t = token.current;
    token.current = null;
    setReady(false);
    widget.current?.reset();
    return t;
  }, []);

  return { ready, failed, take };
}
