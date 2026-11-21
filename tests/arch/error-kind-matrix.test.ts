// Supabase 错误归类的对照表（账号退出链路收口，2026-11-20 现状表第三节）：同一批错误对象喂给设置页、告知页、登录页、同步刷新令牌、
// 会话丢失分类，逐格钉住各自的结果。几处有意不同（例如同步把 refresh_token_already_used 当登录过期、设置页当被移除再查服务器）
// 都写在这张表里；改归类的时候先改这张表，一眼看得出哪一格变了。
// 11-20 收口后改了的格：告知页的四个刷新令牌失效码 unknown → revoked（和设置页一致，exitDevice 先查服务器）；设置页、告知页的超时中止 unknown → offline（断网正则合成一份）
import { describe, expect, it } from 'vitest';
import { classifyAuthLoss } from '../../src/core/auth-loss.ts';
import { mapAuthError } from '../../src/features/auth/data/auth-api.ts';
import { mapConsentError } from '../../src/features/onboarding/data/consent-api.ts';
import { mapSettingsError } from '../../src/features/settings/data/settings-api.ts';
import { toSessionCheck } from '../../src/platform/supabase/sync-errors.ts';

type Row = [name: string, err: unknown, settings: string, consent: string, auth: string, sync: string];

const ROWS: Row[] = [
  ['不是对象', 'boom', 'unknown', 'unknown', 'unknown', 'network'],
  ['message 带 session_revoked', { message: 'session_revoked', status: 400 }, 'revoked', 'revoked', 'unknown', 'expired'],
  ['code unauthorized', { code: 'unauthorized', status: 401 }, 'revoked', 'revoked', 'unknown', 'expired'],
  ['403 session_revoked', { code: 'session_revoked', status: 403 }, 'revoked', 'revoked', 'unknown', 'check'],
  ['只有 401', { status: 401 }, 'revoked', 'revoked', 'unknown', 'expired'],
  ['session_not_found', { code: 'session_not_found', status: 403 }, 'revoked', 'revoked', 'unknown', 'check'],
  ['refresh_token_not_found', { code: 'refresh_token_not_found', status: 400 }, 'revoked', 'revoked', 'unknown', 'check'],
  ['refresh_token_already_used', { code: 'refresh_token_already_used', status: 400 }, 'revoked', 'revoked', 'unknown', 'expired'],
  ['session_expired', { code: 'session_expired', status: 403 }, 'revoked', 'revoked', 'unknown', 'expired'],
  ['AuthSessionMissingError', { name: 'AuthSessionMissingError', status: 400 }, 'signed_out', 'unknown', 'unknown', 'expired'],
  ['account_disabled', { message: 'account_disabled', code: 'P0001', status: 400 }, 'account_disabled', 'disabled', 'unknown', 'expired'],
  ['try_later', { message: 'try_later', status: 400 }, 'try_later', 'try_later', 'unknown', 'expired'],
  ['503', { status: 503 }, 'try_later', 'try_later', 'unknown', 'network'],
  ['AuthRetryableFetchError', { name: 'AuthRetryableFetchError', status: 0 }, 'offline', 'offline', 'offline', 'network'],
  ['TypeError Failed to fetch', { name: 'TypeError', message: 'Failed to fetch' }, 'offline', 'offline', 'offline', 'network'],
  ['Load failed（Safari）', { message: 'Load failed' }, 'offline', 'offline', 'unknown', 'network'],
  ['AbortError timeout', { name: 'AbortError', message: 'signal timed out: timeout' }, 'offline', 'offline', 'unknown', 'network'],
  ['429', { status: 429 }, 'unknown', 'unknown', 'send_quota', 'network'],
  ['is_current_device', { message: 'is_current_device', status: 400 }, 'is_current_device', 'unknown', 'unknown', 'expired'],
  ['policy_ver_mismatch', { message: 'policy_ver_mismatch', status: 400 }, 'unknown', 'version_changed', 'unknown', 'expired'],
  ['otp_expired', { code: 'otp_expired', status: 403 }, 'unknown', 'unknown', 'code_invalid', 'expired'],
];

describe('错误归类对照表', () => {
  for (const [name, err, settings, consent, auth, sync] of ROWS) {
    it(name, () => {
      expect(mapSettingsError(err)).toBe(settings);
      expect(mapConsentError(err)).toBe(consent);
      expect(mapAuthError(err)).toBe(auth);
      expect(toSessionCheck(err)).toBe(sync);
    });
  }

  it('会话丢失分类：只有这四个码要查服务器，其余一律登录过期', () => {
    for (const c of ['session_not_found', 'refresh_token_not_found', 'session_revoked', 'devices_zero_rows']) expect(classifyAuthLoss({ code: c })).toBe('check');
    for (const c of ['refresh_token_already_used', 'session_expired', 'unauthorized', 'none', null]) expect(classifyAuthLoss({ code: c })).toBe('expired');
  });
});
