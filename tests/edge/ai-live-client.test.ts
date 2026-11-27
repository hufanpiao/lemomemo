// 契约：服务器 ai-live-token（supabase/functions/ai-live-token/core.ts）真回的令牌包，客户端（src/features/plus/data/live-token-api.ts 的 liveTokenOf、
// src/platform/live-proto.ts 的 liveUrl）认得、拼得出连接地址；两边的 API 版本是同一个（11-24 评审第 16 条：只留 v1beta、共用一个值）。
// 计数用内存替身（ai-fakes.ts），令牌接口用桩，不碰网络
import { describe, expect, it } from 'vitest';
import { LIVE_API as SERVER_API, handle, type Deps } from '../../supabase/functions/ai-live-token/core.ts';
import { liveTokenOf } from '../../src/features/plus/data/live-token-api.ts';
import { LIVE_API as CLIENT_API, liveUrl } from '../../src/platform/live-proto.ts';
import { fakeGate, UA } from './ai-fakes.ts';

const NOW = Date.UTC(2026, 10, 24, 3, 0);

function deps(): Deps {
  const g = fakeGate({ now: NOW });
  return {
    authenticate: async () => ({ ok: true, user: { userId: UA } }),
    consent: g.consent,
    liveOn: async () => true,
    config: async () => ({ per_user_daily: 50, global_daily: 1000 }),
    key: async () => 'AIza-test',
    own: async () => false,
    isAdmin: g.isAdmin,
    rate: g.rate,
    quota: g.quota,
    quotaUsed: async () => 0,
    logFail: async () => undefined,
    fetch: async () => new Response(JSON.stringify({ name: 'auth_tokens/t1' }), { status: 200 }),
    now: g.now,
    log: g.log,
  };
}

describe('ai-live-token 契约', () => {
  it('服务器和客户端的 API 版本是同一个 v1beta', () => {
    expect(SERVER_API).toBe(CLIENT_API);
    expect(CLIENT_API).toBe('v1beta');
  });

  it('服务器真回的令牌包：客户端认得，拼得出连接地址，setup 原样带回', async () => {
    const res = await handle(new Request('http://x/functions/v1/ai-live-token', { method: 'POST', headers: { 'x-locale': 'ko-KR' } }), deps());
    const got = liveTokenOf(await res.json());
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(liveUrl(got.t.api, got.t.token)).toContain(`.${CLIENT_API}.GenerativeService.BidiGenerateContentConstrained?access_token=auth_tokens%2Ft1`);
    expect(got.t.setup).toMatchObject({ inputAudioTranscription: { languageCodes: ['ko-KR'] } });
  });

  it('服务器的“今天用完”“没同意”“退回”客户端各认成对应原因', async () => {
    const out = deps();
    // 每天 50 次只读计数（评审第 9 条：不再先扣再退）
    out.quotaUsed = async () => 50;
    expect(liveTokenOf(await (await handle(new Request('http://x', { method: 'POST' }), out)).json())).toEqual({ ok: false, why: 'quota_out' });
    const no = deps();
    no.consent = async () => false;
    expect(liveTokenOf(await (await handle(new Request('http://x', { method: 'POST' }), no)).json())).toEqual({ ok: false, why: 'consent' });
    const off = deps();
    off.liveOn = async () => false;
    expect(liveTokenOf(await (await handle(new Request('http://x', { method: 'POST' }), off)).json())).toEqual({ ok: false, why: 'fb_feature_off' });
  });
});
