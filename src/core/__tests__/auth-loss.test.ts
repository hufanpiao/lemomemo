// R-382（架构 4.1a 第 1 点、第 6 点单测）：会话丢了的分类和结局全表（每个码 × session_fate 的结局、查不了）
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHECK_CODES, classifyAuthLoss, resetAuthLossForTest, resolveAuthLoss, type AuthLossSignal } from '../auth-loss.ts';

const A = '00000000-0000-4000-8000-00000000000a';
const S = '00000000-0000-4000-8000-0000000000c1';
const sig = (code: string | null, o: Partial<AuthLossSignal> = {}): AuthLossSignal => ({ path: 'sdk', code, status: 400, sessionId: S, userId: A, ...o });

afterEach(() => resetAuthLossForTest());

const EXPIRED_CODES = ['refresh_token_already_used', 'session_expired', 'bad_jwt', 'unparsable', 'network', 'none', 'refresh_rejected', 'over_request_rate_limit'];

describe('classifyAuthLoss', () => {
  it('四个码要查服务器', () => {
    expect([...CHECK_CODES].sort()).toEqual(['devices_zero_rows', 'refresh_token_not_found', 'session_not_found', 'session_revoked']);
    for (const c of CHECK_CODES) expect(classifyAuthLoss({ code: c })).toBe('check');
  });

  it('其余一律 expired（含没有码）', () => {
    for (const c of [...EXPIRED_CODES, null, undefined, '']) expect(classifyAuthLoss({ code: c })).toBe('expired');
  });
});

describe('resolveAuthLoss 全表', () => {
  for (const code of CHECK_CODES) {
    for (const [fate, want, recorded] of [
      ['revoked', 'removed', 'revoked'],
      ['unknown', 'expired', 'unknown'],
      [null, 'expired', 'unchecked'],
    ] as const) {
      it(`${code} × session_fate ${String(fate)} → ${want}`, async () => {
        resetAuthLossForTest();
        const f = vi.fn(async () => fate);
        const record = vi.fn();
        expect(await resolveAuthLoss(sig(code), { fate: f, record })).toBe(want);
        expect(f).toHaveBeenCalledWith(S, A);
        expect(record).toHaveBeenCalledWith({ userId: A, path: 'sdk', code, status: 400, fate: recorded });
      });
    }
    it(`${code} × 查询抛错 → expired（unchecked）`, async () => {
      resetAuthLossForTest();
      const record = vi.fn();
      const f = vi.fn(async () => {
        throw new Error('x');
      });
      expect(await resolveAuthLoss(sig(code), { fate: f, record })).toBe('expired');
      expect(record.mock.calls[0]?.[0]).toMatchObject({ fate: 'unchecked' });
    });
    it(`${code} 但 sid 或 uid 为 null → 不查、expired`, async () => {
      const f = vi.fn(async () => 'revoked' as const);
      expect(await resolveAuthLoss(sig(code, { sessionId: null }), { fate: f, record: vi.fn() })).toBe('expired');
      expect(await resolveAuthLoss(sig(code, { userId: null }), { fate: f, record: vi.fn() })).toBe('expired');
      expect(f).not.toHaveBeenCalled();
    });
  }

  it('expired 类的码不查服务器', async () => {
    for (const code of EXPIRED_CODES) {
      const f = vi.fn(async () => 'revoked' as const);
      const record = vi.fn();
      expect(await resolveAuthLoss(sig(code), { fate: f, record })).toBe('expired');
      expect(f).not.toHaveBeenCalled();
      expect(record.mock.calls[0]?.[0]).toMatchObject({ fate: 'expired' });
    }
  });

  it('同一个会话判过一次 removed，之后都按 removed、不再查', async () => {
    await resolveAuthLoss(sig('session_not_found'), { fate: async () => 'revoked', record: vi.fn() });
    const f = vi.fn(async () => 'unknown' as const);
    expect(await resolveAuthLoss(sig('refresh_token_already_used'), { fate: f, record: vi.fn() })).toBe('removed');
    expect(f).not.toHaveBeenCalled();
  });

  it('没有 uid 不记；记录抛错不挡结局', async () => {
    const record = vi.fn();
    await resolveAuthLoss(sig('session_expired', { userId: null }), { record });
    expect(record).not.toHaveBeenCalled();
    const boom = vi.fn(() => {
      throw new Error('x');
    });
    expect(await resolveAuthLoss(sig('session_expired'), { record: boom })).toBe('expired');
  });
});
