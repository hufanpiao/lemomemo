// AI 回放（B3 任务单 BE-6）：回放桩补回 TC-B1-15（未同意账号 Gemini 调用 0 次）、
// 坏输出、超时、额度用完（TC-B3-06、07）、未同意（TC-B3-25）。服务商是真的 GeminiProvider，fetch 换成回放桩（tests/ai/replay/），
// 回放文件在 tests/ai/replay/cassettes/（手写，未经真调用录制）。录制器和 gitleaks（TC-B0-90）在 ai-replay-recorder.test.ts。门的依赖用 ai-fakes.ts 的内存替身；校验、本机规则、行映射注入真的 shared。
import { afterEach, describe, expect, it, vi } from 'vitest';
import { todayOf } from '../../shared/core/date.ts';
import { isValidTz } from '../../shared/core/tz.ts';
import { captureRow } from '../../shared/logic/capture-map.ts';
import { arrangeHint, confidence, parseSplit, recurHint } from '../../shared/logic/parse/index.ts';
import { AI_AUDIO_MAX_BYTES, audioType, aiParseRequest, checkDefaultDay, checkParseOutput, checkVoiceOutput, normLocale, normProjects, type AiItem } from '../../shared/schema/ai.ts';
import { nextPacificMidnight } from '../../supabase/functions/_shared/ai/gate.ts';
import { PARSE_TIMEOUT_MS, VOICE_TIMEOUT_MS } from '../../supabase/functions/_shared/ai/params.ts';
import { makeParseWithAI, recordOnly } from '../../supabase/functions/_shared/ai/parse-core.ts';
import { handle as parseHandle, type Deps as ParseDeps } from '../../supabase/functions/ai-parse/core.ts';
import { handle as voiceHandle, type Deps as VoiceDeps } from '../../supabase/functions/ai-voice/core.ts';
import { handle as intakeHandle, type Deps as IntakeDeps, type Row } from '../../supabase/functions/claude-intake/core.ts';
import { randomToken, tokenHash } from '../../supabase/functions/_shared/intake-token.ts';
import { replayProvider, type Replay } from '../ai/replay/replay.ts';
import { fakeGate, UA, used, type FakeGate, type GateOpts } from './ai-fakes.ts';

const NOW = Date.UTC(2026, 9, 28, 3, 0);   // 首尔 10-28 12:00
const { parseWithAI, recordWithAI, voiceWithAI } = makeParseWithAI<AiItem>({ checkParseOutput, checkVoiceOutput, checkDefaultDay });

/** 门用内存替身，服务商换成“真 GeminiProvider + 回放桩” */
function gateWith(cassette: string, o: GateOpts = {}): { g: FakeGate; rp: Replay } {
  const g = fakeGate({ now: NOW, ...o });
  const { provider, rp } = replayProvider(cassette);
  return { g: { ...g, provider: Object.assign(() => provider, { stub: g.provider.stub }) }, rp };
}

const authed = async () => ({ ok: true as const, user: { userId: UA } });
const call = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

function parseDeps(g: FakeGate): ParseDeps<AiItem> {
  return {
    ...g, authenticate: authed,
    logic: {
      parseRequest: (b) => {
        const r = aiParseRequest.safeParse(b);
        return r.success ? { ok: true, value: r.data } : { ok: false };
      },
      normLocale, normProjects, isValidTz, checkDefaultDay, parseWithAI,
    },
  };
}
const parseReq = () => new Request('http://kong/functions/v1/ai-parse', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-app-version': '4.0.0' },
  body: JSON.stringify({ text: '明天下午三点开会', now: NOW, tz: 'Asia/Seoul', locale: 'zh-CN', projects: [] }),
});

function voiceDeps(g: FakeGate) {
  const fails: { code: string; fields: string[] }[] = [];
  const deps: VoiceDeps<AiItem> = {
    ...g, authenticate: authed, logic: { maxAudio: AI_AUDIO_MAX_BYTES, audioType, normLocale, normProjects, isValidTz, checkDefaultDay, voiceWithAI },
    async logFail(_u, code, fields) {
      fails.push({ code, fields });
    },
  };
  return { deps, fails };
}
const voiceReq = () => new Request('http://kong/functions/v1/ai-voice', {
  method: 'POST', headers: { 'content-type': 'audio/webm', 'x-now': String(NOW), 'x-tz': 'Asia/Seoul', 'x-locale': 'zh-CN' }, body: new Uint8Array(64),
});

/** claude-intake：连接码、库都是内存替身，写库收下来看 */
async function intake(g: FakeGate) {
  const token = randomToken();
  const rows = new Map([[await tokenHash(token), { id: '7e57a0a0-0000-4000-8000-000000000001', user_id: UA, scopes: ['create'], created_at: new Date(NOW - 86_400_000).toISOString(), revoked_at: null }]]);
  const inserted: Record<string, unknown>[] = [];
  let n = 0;
  const deps: IntakeDeps<AiItem> = {
    gate: g,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    logic: {
      parseSplit: (text, now, tz, locale, projects, opts) => parseSplit(text, now, tz, locale, projects, { features: [...opts.features] }),
      confidence: (r) => confidence(r as Parameters<typeof confidence>[0]),
      checkParseOutput: (raw, ctx) => recordOnly(checkParseOutput(raw, ctx)), recordWithAI,
      captureRow: (item, ctx) => captureRow(item, ctx) as Row | null,
      todayOf, recurHint, arrangeHint, normLocale, isValidTz,
    },
    store: {
      findToken: async (h) => rows.get(h) ?? null,
      usable: async () => true,
      takeRate: async () => true,
      profile: async () => ({ current_tz: 'Asia/Seoul', ui_locale: 'zh-CN' }),
      projects: async () => [],
      async insertAll(_u, byTable) {
        for (const t of ['events', 'todos', 'anniversaries'] as const) inserted.push(...(byTable[t] ?? []));
      },
      touchToken: async () => {},
      logFail: async () => {},
    },
  };
  const send = async (text: string) => call(await intakeHandle(new Request('http://kong/functions/v1/claude-intake', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-app-version': '4.0.0' }, body: JSON.stringify({ text }),
  }), deps));
  return { send, inserted };
}
/** 本机规则没把握、要走 AI 的一句（claude-intake.test.ts 同一句） */
const VAGUE = '下周找时间和老王聊聊合同的事';

/** 等到回放桩被调到（用 setImmediate 让出，不受假计时器影响；最多让 1000 次） */
async function untilCalled(rp: Replay): Promise<void> {
  for (let i = 0; i < 1000 && rp.calls === 0; i++) await new Promise((r) => setImmediate(r));
  expect(rp.calls).toBe(1);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('TC-B1-15（回放桩补回）、TC-B3-25：未同意 AI 的账号，本批全部会调 AI 的路径 Gemini 调用 0 次', () => {
  it('ai-parse、ai-voice 回 consent_required；claude-intake 只走本机规则照样记下；三条路回放桩都是 0 次、不扣次数', async () => {
    const a = gateWith('parse-ok', { consent: false });
    expect((await call(await parseHandle(parseReq(), parseDeps(a.g)))).body).toEqual({ consent_required: true });
    const b = gateWith('voice-ok', { consent: false });
    expect((await call(await voiceHandle(voiceReq(), voiceDeps(b.g).deps))).body).toEqual({ consent_required: true });
    const c = gateWith('parse-ok-todo', { consent: false });
    const w = await intake(c.g);
    const r = await w.send(VAGUE);
    expect(r.status).toBe(200);
    expect(w.inserted.map((x) => x['title'])).toEqual([VAGUE]);
    expect([a.rp.calls, b.rp.calls, c.rp.calls]).toEqual([0, 0, 0]);
    expect([used(a.g, 'ai:'), used(b.g, 'ai:'), used(c.g, 'ai:')]).toEqual([0, 0, 0]);
  });
  it('对照：同意了，同样三条路回放桩各 1 次（证明桩接上了，0 次不是因为没接）', async () => {
    const a = gateWith('parse-ok');
    const pr = await call(await parseHandle(parseReq(), parseDeps(a.g)));
    expect(pr.body).toMatchObject({ intent: 'record', items: [{ kind: 'event', title: '开会' }] });
    const b = gateWith('voice-ok');
    expect((await call(await voiceHandle(voiceReq(), voiceDeps(b.g).deps))).body).toMatchObject({ transcript: '明天下午三点开会' });
    const c = gateWith('parse-ok-todo');
    const w = await intake(c.g);
    await w.send(VAGUE);
    expect(w.inserted.map((x) => [x['title'], x['short_by']])).toEqual([['和老王聊合同', 'ai']]);
    expect([a.rp.calls, b.rp.calls, c.rp.calls]).toEqual([1, 1, 1]);
    // 请求真的经 GeminiProvider 组装：原话包在内容里
    expect(JSON.stringify(a.rp.sent[0])).toContain('明天下午三点开会');
  });
});

describe('TC-B3-06：回放 Gemini 额度用完', () => {
  it('ai-parse 回 {fallback, quota}（客户端走本机规则），写 exhausted_until = 太平洋下一个午夜，退回预扣；之后不再调 Gemini、不扣次数', async () => {
    const { g, rp } = gateWith('quota');
    expect((await call(await parseHandle(parseReq(), parseDeps(g)))).body).toEqual({ fallback: true, reason: 'quota' });
    expect(g.exhaustedAt).toEqual([nextPacificMidnight(NOW)]);
    expect(used(g, 'ai:')).toBe(0);
    const after = gateWith('quota', { exhaustedUntil: nextPacificMidnight(NOW) });
    expect((await call(await parseHandle(parseReq(), parseDeps(after.g)))).body).toEqual({ fallback: true, reason: 'quota' });
    expect([rp.calls, after.rp.calls]).toEqual([1, 0]);
  });
  it('claude-intake：额度用完照样按本机规则存下原话，不扣次数', async () => {
    const { g, rp } = gateWith('quota');
    const w = await intake(g);
    expect((await w.send(VAGUE)).status).toBe(200);
    expect(w.inserted.map((x) => x['title'])).toEqual([VAGUE]);
    expect([rp.calls, used(g, 'ai:'), g.exhaustedAt.length]).toEqual([1, 0, 1]);
  });
  it('ai-voice：额度用完回 ai_failed quota，写 exhausted_until，退回预扣', async () => {
    const { g } = gateWith('quota');
    const v = voiceDeps(g);
    expect((await call(await voiceHandle(voiceReq(), v.deps))).body).toEqual({ ai_failed: true, reason: 'quota' });
    expect([g.exhaustedAt.length, used(g, 'ai:')]).toEqual([1, 0]);
  });
  // 11-13 ai-eval #2：每分钟限额撞一下就停一整天。回放文件 quota-minute / quota-day 的回复体带 QuotaFailure、RetryInfo
  // 给客户端的 reason 回 error（11-13 评审第 1 条：客户端见到 quota 就记“今天用完”、AI 关到午夜）；服务器日志照旧 ai_quota kind=minute
  it('每分钟限额（quota-minute，retryDelay 12s）：ai-parse、ai-voice、claude-intake 都只停到 12 秒后，给客户端回 reason error；日志带 kind=minute，不带谷歌原文', async () => {
    const p = gateWith('quota-minute');
    expect((await call(await parseHandle(parseReq(), parseDeps(p.g)))).body).toEqual({ fallback: true, reason: 'error' });
    expect([p.g.exhaustedAt, used(p.g, 'ai:'), p.g.logs]).toEqual([[NOW + 12_000], 0, ['ai_quota kind=minute']]);
    const v = gateWith('quota-minute');
    const vd = voiceDeps(v.g);
    expect((await call(await voiceHandle(voiceReq(), vd.deps))).body).toEqual({ ai_failed: true, reason: 'error' });
    expect([v.g.exhaustedAt, vd.fails]).toEqual([[NOW + 12_000], [{ code: 'ai_quota', fields: ['status=429', 'kind=minute', 'bytes=<16k'] }]]);
    // 12 秒内再来一次：门第 ⑤ 步拦下，同样回 error、不调 Gemini；ai-voice 记 quota_exhausted kind=minute
    const again = voiceDeps(v.g);
    expect((await call(await voiceHandle(voiceReq(), again.deps))).body).toEqual({ fallback: true, reason: 'error' });
    expect([v.rp.calls, again.fails]).toEqual([1, [{ code: 'quota_exhausted', fields: ['kind=minute', 'bytes=<16k'] }]]);
    const i = gateWith('quota-minute');
    expect((await (await intake(i.g)).send(VAGUE)).status).toBe(200);
    expect([i.g.exhaustedAt, i.g.logs]).toEqual([[NOW + 12_000], ['ai_quota kind=minute']]);
    for (const x of [p.g.logs, vd.fails, i.g.logs]) expect(JSON.stringify(x)).not.toMatch(/FreeTier|exceeded/);
  });
  it('每天限额（quota-day，谷歌也给了 retryDelay 1s）：照旧停到太平洋下一个午夜，日志带 kind=day；认不出的（quota）记 kind=unknown、也停到午夜', async () => {
    const d = gateWith('quota-day');
    expect((await call(await parseHandle(parseReq(), parseDeps(d.g)))).body).toEqual({ fallback: true, reason: 'quota' });
    expect([d.g.exhaustedAt, d.g.logs]).toEqual([[nextPacificMidnight(NOW)], ['ai_quota kind=day']]);
    const u = gateWith('quota');
    await parseHandle(parseReq(), parseDeps(u.g));
    expect([u.g.exhaustedAt, u.g.logs]).toEqual([[nextPacificMidnight(NOW)], ['ai_quota kind=unknown']]);
  });
});

describe('TC-B3-07：回放坏输出、超时', () => {
  it('坏输出（不是 JSON）：GeminiProvider 判 error，ai-parse 回 fallback、退回预扣', async () => {
    const { g, rp } = gateWith('bad-not-json');
    expect((await call(await parseHandle(parseReq(), parseDeps(g)))).body).toEqual({ fallback: true, reason: 'error' });
    expect([rp.calls, used(g, 'ai:')]).toEqual([1, 0]);
  });
  it('坏输出（JSON 不合 schema）：被 zod 拒，ai-parse 回 fallback invalid，只把原因写 logs，退回预扣', async () => {
    const { g } = gateWith('bad-schema');
    expect((await call(await parseHandle(parseReq(), parseDeps(g)))).body).toEqual({ fallback: true, reason: 'invalid' });
    expect(g.invalid.length).toBe(1);
    expect(g.invalid[0]?.src).toBe('ai-parse');
    expect(JSON.stringify(g.invalid)).not.toContain('开会');
    expect(used(g, 'ai:')).toBe(0);
  });
  it('坏输出到了 claude-intake：退回本机规则，原话照样存下', async () => {
    for (const name of ['bad-not-json', 'bad-schema', 'http-500']) {
      const { g } = gateWith(name);
      const w = await intake(g);
      expect((await w.send(VAGUE)).status, name).toBe(200);
      expect(w.inserted.map((x) => x['title']), name).toEqual([VAGUE]);
      expect(used(g, 'ai:'), name).toBe(0);
    }
  });
  it('超时：ai-parse 到 5 秒中止、回 fallback timeout（客户端有提示、原话不丢，退本机规则），退回预扣', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { g, rp } = gateWith('timeout');
    const pending = parseHandle(parseReq(), parseDeps(g));
    await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS - 1);
    expect(rp.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await call(await pending)).body).toEqual({ fallback: true, reason: 'timeout' });
    expect(used(g, 'ai:')).toBe(0);
  });
  it('超时：ai-voice 到 15 秒中止，回 ai_failed timeout，写 ai_timeout（只带类型名）', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { g } = gateWith('timeout');
    const v = voiceDeps(g);
    const pending = voiceHandle(voiceReq(), v.deps);
    await vi.advanceTimersByTimeAsync(VOICE_TIMEOUT_MS);
    expect((await call(await pending)).body).toEqual({ ai_failed: true, reason: 'timeout' });
    expect(v.fails.map((f) => f.code)).toEqual(['ai_timeout']);
    expect(v.fails[0]?.fields).toContain('type=AbortError');
  });
  it('超时：claude-intake 退回本机规则，原话不丢', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { g, rp } = gateWith('timeout');
    const w = await intake(g);
    const pending = w.send(VAGUE);
    await untilCalled(rp);   // 先过连接码哈希等异步步骤，Gemini 那一步的计时器挂上了再推进
    await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS);
    expect((await pending).status).toBe(200);
    expect(w.inserted.map((x) => x['title'])).toEqual([VAGUE]);
  });
});
