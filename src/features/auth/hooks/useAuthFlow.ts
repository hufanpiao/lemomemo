// 登录页的流程（架构 5.6、5.9；线框 s14“一个流程：先填邮箱，新邮箱才需要邀请码”）
//   email ──发码成功──▶ code ──填满 6 位自动校验──▶ done（跳回 /app/）
//     └─回“还没注册”─▶ invite ──邀请码 + 人机验证──▶ invite-code ──填满 6 位──▶ done
// 错误各自一张卡片；发得太频繁、刚发过码都有 60 秒倒计时（Supabase：同一邮箱 60 秒一次）
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { useUi } from '../../../kit/state/ui-store.ts';
import {
  createAuthApi,
  isEmail,
  isInviteFormat,
  normalizeInvite,
  normalizeOtp,
  splitCodeError,
  type AuthApi,
  type AuthErr,
} from '../data/auth-api.ts';
import type { ExitSteps } from '../../../platform/sign-out.ts';
import type { Captcha } from './useTurnstile.ts';

export type { AuthErr };

export type AuthStep = 'email' | 'code' | 'invite' | 'invite-code' | 'done';

/** 发码以后多久才能再发（毫秒） */
export const RESEND_MS = 60_000;

export interface AuthFlowState {
  step: AuthStep;
  email: string;
  invite: string;
  code: string;
  busy: boolean;
  error: AuthErr | null;
  /** 表单本身的提示（邮箱格式、邀请码位数、人机验证还没好），不是服务器回的错误 */
  hint: 'email_format' | 'invite_format' | 'captcha_wait' | null;
  /** 还要等几秒才能再发码；0 表示现在就能发 */
  cooldown: number;
}

export interface AuthFlowDeps {
  api?: AuthApi;
  now?: () => number;
  /** 拿到会话以后做什么（默认跳回 /app/，15.6 第 4b 条：同源，会话存储共用）；已登录时的“回到 App”也用它 */
  onDone?: () => void;
  /** 测试用：本机会话里的 user_id（默认 platform/session.ts 的 readSessionUserId） */
  readUserId?: () => string | null;
  /** 测试用：退出后清本机的几步（默认 platform/sign-out.ts 的 defaultExitSteps） */
  localExit?: ExitSteps;
  /** 测试用：“退出并换账号”服务器那一半的总超时（默认 useSessionGate 的 SIGN_OUT_TIMEOUT_MS） */
  signOutTimeoutMs?: number;
}

const defaultApi = (): AuthApi => createAuthApi(getSupabase);
const goApp = () => location.replace('/app/');

export function useAuthFlow(captcha: Captcha, deps: AuthFlowDeps = {}) {
  const api = useMemo(() => deps.api ?? defaultApi(), [deps.api]);
  const now = deps.now ?? Date.now;
  const onDone = deps.onDone ?? goApp;
  const locale = useUi((s) => s.locale);

  const [step, setStep] = useState<AuthStep>('email');
  const [email, setEmailRaw] = useState('');
  const [invite, setInviteRaw] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthErr | null>(null);
  const [hint, setHint] = useState<AuthFlowState['hint']>(null);
  const [sentAt, setSentAt] = useState(0);
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [tick, setTick] = useState(() => now());

  // 倒计时：只在有倒计时的时候每秒刷新一次
  useEffect(() => {
    if (cooldownUntil <= tick) return undefined;
    const id = setInterval(() => setTick(now()), 1000);
    return () => clearInterval(id);
  }, [cooldownUntil, tick, now]);
  const cooldown = Math.max(0, Math.ceil((cooldownUntil - tick) / 1000));

  /** 开始倒计时；waitS 是服务器限频原文里的 N 秒（K4 复审低 3），没有就按 60 秒 */
  const startCooldown = useCallback(
    (waitS?: number) => {
      const t = now();
      setTick(t);
      setCooldownUntil(t + (waitS === undefined ? RESEND_MS : waitS * 1000));
    },
    [now],
  );

  /** 拿一个人机验证令牌；还没有就提示等一下 */
  const takeCaptcha = useCallback((): string | null => {
    const t = captcha.ready ? captcha.take() : null;
    if (!t) setHint('captcha_wait');
    return t;
  }, [captcha]);

  const finish = useCallback(() => {
    setStep('done');
    onDone();
  }, [onDone]);

  const sendCode = useCallback(async () => {
    setError(null);
    setHint(null);
    if (!isEmail(email)) {
      setHint('email_format');
      return;
    }
    if (cooldownUntil > now()) return; // 按真实时钟判断，不用每秒刷新的显示值
    const token = takeCaptcha();
    if (!token) return;
    setBusy(true);
    const r = await api.sendCode(email.trim(), token);
    setBusy(false);
    if (r.ok) {
      setSentAt(now());
      startCooldown();
      setCode('');
      setStep('code');
      return;
    }
    if (r.error === 'not_registered') {
      setStep('invite');
      return;
    }
    if (r.error === 'rate_limited') startCooldown(r.waitS);
    setError(r.error);
  }, [api, email, cooldownUntil, takeCaptcha, now, startCooldown]);

  const sendInvite = useCallback(async () => {
    setError(null);
    setHint(null);
    if (!isInviteFormat(invite)) {
      setHint('invite_format');
      return;
    }
    if (cooldownUntil > now()) return; // 按真实时钟判断，不用每秒刷新的显示值
    const token = takeCaptcha();
    if (!token) return;
    setBusy(true);
    const r = await api.inviteStart({ email: email.trim(), code: normalizeInvite(invite), captchaToken: token, locale });
    setBusy(false);
    if (r.ok) {
      // 5.6：码对不对都回同样的 {ok}，界面也只说“邀请码有效的话，验证码会发到这个邮箱”
      setSentAt(now());
      startCooldown();
      setCode('');
      setStep('invite-code');
      return;
    }
    // start 只会回 captcha_failed、try_later（架构 0.38 第 27 条），没有限频卡片
    setError(r.error);
  }, [api, email, invite, cooldownUntil, takeCaptcha, locale, now, startCooldown]);

  const verify = useCallback(
    async (otp: string) => {
      setError(null);
      setBusy(true);
      const r =
        step === 'invite-code'
          ? await api.inviteVerify({ email: email.trim(), code: normalizeInvite(invite), emailOtp: otp, locale })
          : await api.verifyCode(email.trim(), otp);
      setBusy(false);
      if (r.ok) {
        finish();
        return;
      }
      // 回到邮箱那一屏（邮箱保留）再提示的三种（架构 5.6、0.38 第 20 条）：
      // - registered_login：账号已建好、没换到会话（link_failed 502），请用邮箱验证码登录（安全审查低 4）
      // - email_exists：这个邮箱已注册（409），直接去登录
      // - too_many_tries：验证码试错太多次已失效（400），从填邮箱重新开始
      if (r.error === 'registered_login' || r.error === 'email_exists' || r.error === 'too_many_tries') {
        setStep('email');
        setCode('');
        setInviteRaw('');
        setError(r.error);
        return;
      }
      setError(splitCodeError(r.error, sentAt, now()));
    },
    [api, step, email, invite, locale, sentAt, now, finish],
  );

  /** 验证码输入：只留数字，填满 6 位自动提交（5.9“键盘弹起”） */
  const setCodeInput = useCallback(
    (raw: string) => {
      const v = normalizeOtp(raw);
      setCode(v);
      if (v.length === 6 && !busy) void verify(v);
    },
    [busy, verify],
  );

  /** 在验证码那一屏重新发：已有用户再发一次登录码；邀请注册再走一次 start */
  const resend = useCallback(() => (step === 'invite-code' ? sendInvite() : sendCode()), [step, sendInvite, sendCode]);

  const backToEmail = useCallback(() => {
    setStep('email');
    setCode('');
    setInviteRaw('');
    setError(null);
    setHint(null);
  }, []);

  /** 卡片上的“重新输入”：清掉错误和输入框，留在这一屏 */
  const dismissError = useCallback(() => {
    setError(null);
    if (error === 'code_wrong') setCode('');
    if (error === 'invite_invalid') {
      setInviteRaw('');
      setStep('invite');
    }
  }, [error]);

  const setEmail = useCallback((v: string) => {
    setEmailRaw(v);
    setHint(null);
  }, []);
  const setInvite = useCallback((v: string) => {
    setInviteRaw(v);
    setHint(null);
  }, []);

  const state: AuthFlowState = { step, email, invite, code, busy, error, hint, cooldown };
  return { state, setEmail, setInvite, setCode: setCodeInput, sendCode, sendInvite, resend, backToEmail, dismissError };
}
