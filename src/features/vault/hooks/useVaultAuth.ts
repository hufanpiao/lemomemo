// Face ID / Windows Hello 和“忘记密码”重设（B5 S3、S4；代定 D5、D18）
// • useWebauthn：这台设备能不能用（exe、不支持的环境不显示，platform/webauthn.ts）、按钮上的叫法（label）、
//   解锁卡和入口行给不给 Face ID（canUnlock：能用、绑定过、没有“别处改过密码”）、解锁、绑定（绑定要当场输密码）；
//   叫法和 canUnlock 原来在四个界面各写一份（审查第 11 条），只留这里
// • useVaultReset：发验证码 → 验证码 + 交接设备行（core/session-rebind.ts）→ 设新密码（vault {reset, new_pin}）
import { useCallback, useEffect, useState } from 'react';
import { getBoot } from '../../../core/boot.ts';
import { createSessionRebind, type RebindErr } from '../../../core/session-rebind.ts';
import { buildInfo, isAppleMobile } from '../../../platform/env.ts';
import { appFetch } from '../../../platform/http.ts';
import { readSessionEmail } from '../../../platform/session.ts';
import { getSupabase } from '../../../platform/supabase/client.ts';
import { createEphemeralDb } from '../../../platform/supabase/ephemeral.ts';
import { createPasskey, getAssertion, webauthnUsable } from '../../../platform/webauthn.ts';
import type { VaultState } from '../data/session.ts';
import type { VaultResult } from '../data/vault-api.ts';
import { useVault } from './useVault.ts';
import { useVaultT } from './useVaultT.ts';

export type Method = 'faceid' | 'hello';

let usableMemo: Promise<boolean> | null = null;

export function useWebauthn() {
  const { s } = useVault();
  const t = useVaultT();
  const [usable, setUsable] = useState(false);
  useEffect(() => {
    let live = true;
    void (usableMemo ??= webauthnUsable()).then((v) => {
      if (live) setUsable(v);
    });
    return () => {
      live = false;
    };
  }, []);
  const method: Method = isAppleMobile() ? 'faceid' : 'hello';
  const label = t(method === 'faceid' ? 'vault.method.faceid' : 'vault.method.hello', {});
  const canUnlock = (st: VaultState): boolean => usable && (st.status?.webauthn ?? 0) > 0 && !st.relocked;

  const unlock = useCallback(async (): Promise<VaultResult<true> | null> => {
    const o = await s.webauthnOptions('unlock');
    if (!o.ok) return o;
    const a = await getAssertion({ challenge: o.value.challenge, rpId: o.value.rp_id, timeoutMs: o.value.timeout_ms, userId: o.value.user_id, credentialIds: o.value.credential_ids });
    if (!a) return null;
    return s.unlockWebauthn(a);
  }, [s]);

  const register = useCallback(async (pin: string, label: string): Promise<VaultResult<true> | null> => {
    const o = await s.webauthnOptions('register');
    if (!o.ok) return o;
    const att = await createPasskey(
      { challenge: o.value.challenge, rpId: o.value.rp_id, timeoutMs: o.value.timeout_ms, userId: o.value.user_id, credentialIds: o.value.credential_ids },
      readSessionEmail() ?? 'lemo',
    );
    if (!att) return null;
    const r = await s.registerWebauthn(pin, label, att);
    return r.ok ? { ok: true, value: true } : r;
  }, [s]);

  return { usable, method, label, canUnlock, unlock, register };
}

export type ResetStep = 'intro' | 'code' | 'pin' | 'done';

async function deviceId(): Promise<string | null> {
  try {
    const cache = getBoot()?.cache;
    if (!cache || cache.isClosed()) return null;
    const rec = await cache.getMeta('device');
    return typeof rec?.id === 'string' ? rec.id : null;
  } catch {
    return null;
  }
}

/**
 * 交接设备行的实例整页只建一个（11-14 整块评审第 4 条）：结果不确定时留着的新会话 S2 在它里面，
 * 跟着组件建的话离开重设页就丢了（之后既不能重发交接，也挡不住 core/rebind-pending.ts 的退出闸）
 */
let rebindOne: ReturnType<typeof createSessionRebind> | null = null;
const rebindOf = () =>
  (rebindOne ??= createSessionRebind({
    main: async () => (await getSupabase()).auth,
    ephemeral: async () => (await createEphemeralDb()).auth,
    fetch: appFetch,
    accountUrl: `${buildInfo.supabaseUrl}/functions/v1/account`,
    anonKey: buildInfo.anonKey,
  }));

export function useVaultReset() {
  const { s } = useVault();
  const rebind = rebindOf();
  const email = readSessionEmail();
  const [step, setStep] = useState<ResetStep>('intro');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<RebindErr | 'reset_failed' | null>(null);

  const send = useCallback(async () => {
    if (!email) return;
    setBusy(true);
    setError(null);
    const r = await rebind.sendCode(email);
    setBusy(false);
    if (r.ok) setStep('code');
    else setError(r.error);
  }, [email, rebind]);

  const verify = useCallback(async (code: string) => {
    if (!email) return;
    setBusy(true);
    setError(null);
    const r = await rebind.verifyAndRebind(email, code, await deviceId());
    setBusy(false);
    if (r.ok) setStep('pin');
    else setError(r.error);
  }, [email, rebind]);

  const setPin = useCallback(async (pin: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const r = await s.reset(pin);
    setBusy(false);
    if (r.ok) {
      setStep('done');
      return true;
    }
    if (r.code === 'reauth_required') {
      setStep('intro');
      setError('reauth_required');
    } else setError('reset_failed');
    return false;
  }, [s]);

  return { email, step, busy, error, send, verify, setPin };
}
