// 隐私记错误码的落法（TC-B5-47 ③④ 的运行时一半；编译期那一半是 tests/arch-fixtures/tsc/vault-error-unhandled.ts）和 vault-api 的 failOf
import { describe, expect, it } from 'vitest';
import { VAULT_ERROR_CODES } from '../../../../shared/schema/vault.ts';
import { ENTRY_ERROR_CODES } from '../../../../shared/schema/entry-codes.ts';
import { failOf } from '../data/vault-api.ts';
import { vaultErrorAction, type VaultClientCode } from '../data/vault-errors.ts';
import { zh as vaultZh } from '../i18n/zh.ts';
import { ko as vaultKo } from '../i18n/ko.ts';

const CLIENT: VaultClientCode[] = ['session_revoked', 'signed_out', 'offline', 'upgrade_required', 'bad_request', 'unknown'];

describe('vaultErrorAction：每个码都有去处，文案中韩都有', () => {
  it.each([...VAULT_ERROR_CODES, ...CLIENT])('%s', (code) => {
    const a = vaultErrorAction(code);
    expect(vaultZh[a.msg]).toBeTruthy();
    expect(vaultKo[a.msg]).toBeTruthy();
  });

  it('几个关键码的落法', () => {
    expect(vaultErrorAction('vault_locked').kind).toBe('unlock');
    expect(vaultErrorAction('vault_relock').kind).toBe('relock');
    expect(vaultErrorAction('session_revoked').kind).toBe('revoked');
    expect(vaultErrorAction('try_later').kind).toBe('message');
  });

  it('④ 入口共用码表里有 session_revoked（续第 98 条）', () => {
    expect(ENTRY_ERROR_CODES).toContain('session_revoked');
  });
});

describe('failOf：失败响应 → 码', () => {
  it('隐私记码原样，带 left、retry_after_s', () => {
    expect(failOf(403, { error: 'pin_wrong', left: 2 })).toEqual({ ok: false, code: 'pin_wrong', left: 2 });
    expect(failOf(423, { error: 'pin_locked', retry_after_s: 60 })).toEqual({ ok: false, code: 'pin_locked', retryAfterS: 60 });
    expect(failOf(401, { error: 'vault_relock' })).toEqual({ ok: false, code: 'vault_relock' });
  });

  it('入口共用码：unauthorized、session_revoked → session_revoked；method_not_allowed → bad_request；misconfigured → unknown', () => {
    expect(failOf(401, { error: 'unauthorized' }).code).toBe('session_revoked');
    expect(failOf(401, { error: 'session_revoked' }).code).toBe('session_revoked');
    expect(failOf(405, { error: 'method_not_allowed' }).code).toBe('bad_request');
    expect(failOf(500, { error: 'misconfigured' }).code).toBe('unknown');
  });

  it('没有码按状态：426 → upgrade_required、401 → session_revoked、5xx → try_later、别的 → unknown', () => {
    expect(failOf(426, null).code).toBe('upgrade_required');
    expect(failOf(401, null).code).toBe('session_revoked');
    expect(failOf(503, 'x').code).toBe('try_later');
    expect(failOf(404, { error: 'toString' }).code).toBe('unknown');
  });
});
