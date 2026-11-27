// 向 ai-live-token 要短期令牌（data/live-token-api.ts）：回包形状核对、各种退回原因、请求头带界面语言、日志不记令牌
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import { AI_LIVE_TOKEN_FN, fetchLiveToken, liveTokenOf, type CallPost } from '../data/live-token-api.ts';
import { SendError } from '../data/send-error.ts';

const OK = { token: 'auth_tokens/secret1', expire_at: '2026-11-24T00:05:00Z', model: 'gemini-3.5-transcribe-live', api: 'v1beta', setup: { model: 'models/x' } };

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
});
afterEach(() => {
  delete (globalThis as Record<string, unknown>)[RL_SLOT];
});

describe('liveTokenOf 回包核对', () => {
  it('正常回包：取令牌、版本、setup（发令牌不扣次数，不带剩余次数）', () => {
    expect(liveTokenOf(OK)).toEqual({ ok: true, t: { token: OK.token, api: 'v1beta', setup: OK.setup } });
  });

  it('没同意、用完、服务器让退回：各回原因', () => {
    expect(liveTokenOf({ consent_required: true })).toEqual({ ok: false, why: 'consent' });
    expect(liveTokenOf({ quota_out: true })).toEqual({ ok: false, why: 'quota_out' });
    expect(liveTokenOf({ fallback: true, reason: 'error' })).toEqual({ ok: false, why: 'fb_error' });
    expect(liveTokenOf({ fallback: true, reason: 'X<script>' })).toEqual({ ok: false, why: 'fb' });
  });

  it('形状不对一律 bad', () => {
    for (const v of [null, [], 'x', { ...OK, token: '' }, { ...OK, token: 1 }, { ...OK, api: 'v2' }, { ...OK, api: 'v1alpha' }, { ...OK, setup: [] }, { ...OK, token: 'x'.repeat(2049) }]) {
      expect(liveTokenOf(v)).toEqual({ ok: false, why: 'bad' });
    }
  });
});

describe('fetchLiveToken', () => {
  it('发到 ai-live-token，请求头带界面语言；日志不记令牌', async () => {
    const post = vi.fn<CallPost>(async () => OK);
    const r = await fetchLiveToken('ko-KR', new AbortController().signal, post);
    expect(r.ok).toBe(true);
    expect(post.mock.calls[0]?.[0]).toBe(AI_LIVE_TOKEN_FN);
    expect(post.mock.calls[0]?.[1]).toEqual({ headers: { 'x-locale': 'ko-KR' }, body: '' });
    expect(lines).toEqual(['voice gem token ok']);
    expect(lines.join('\n')).not.toContain('secret1');
  });

  it('发不出去：按发送错误归类；被中止算 timeout', async () => {
    const http = await fetchLiveToken('zh-CN', new AbortController().signal, async () => {
      throw new SendError('http');
    });
    expect(http).toEqual({ ok: false, why: 'http' });
    const ac = new AbortController();
    ac.abort();
    const to = await fetchLiveToken('zh-CN', ac.signal, async () => {
      throw new Error('x');
    });
    expect(to).toEqual({ ok: false, why: 'timeout' });
    expect(lines).toContain('voice gem token fail why=timeout');
  });
});
