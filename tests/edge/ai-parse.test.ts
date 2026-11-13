// ai-parse、ai-voice 的 handle（core.ts）：门用内存替身，服务商用桩，校验和入参规整注入真的 shared。
// B3 任务单 BE-4、S8、S12、M3；TC-B3-24（超长音频边读边计数）、25、26、42、50；Q2（服务器包 intent）。
import { describe, expect, it } from 'vitest';
import { isValidTz } from '../../shared/core/tz.ts';
import { AI_AUDIO_MAX_BYTES, audioType, aiParseRequest, aiResponse, checkDefaultDay, checkParseOutput, checkVoiceOutput, normLocale, normProjects, type AiItem } from '../../shared/schema/ai.ts';
import { makeParseWithAI } from '../../supabase/functions/_shared/ai/parse-core.ts';
import { handle as parseHandle, MAX_BODY, type Deps as ParseDeps } from '../../supabase/functions/ai-parse/core.ts';
import { bytesBucket, decodeProjects, handle as voiceHandle, MAX_PROJECTS_HEADER, readCapped, type Deps as VoiceDeps } from '../../supabase/functions/ai-voice/core.ts';
import { fakeGate, okJson, UA, used, type GateOpts } from './ai-fakes.ts';

const { parseWithAI, voiceWithAI } = makeParseWithAI<AiItem>({ checkParseOutput, checkVoiceOutput, checkDefaultDay });
const NOW = Date.UTC(2026, 9, 28, 3, 0);
const EV = { kind: 'event', title: '开会', date: '2026-10-29', time: '15:00', date_basis: 'rel' };
const authed = async () => ({ ok: true as const, user: { userId: UA } });

function parseDeps(o: GateOpts = {}) {
  const g = fakeGate({ reply: () => okJson({ items: [EV] }), ...o });
  const deps: ParseDeps<AiItem> = {
    ...g,
    authenticate: authed,
    logic: {
      parseRequest: (b) => {
        const r = aiParseRequest.safeParse(b);
        return r.success ? { ok: true, value: r.data } : { ok: false };
      },
      normLocale, normProjects, isValidTz, checkDefaultDay, parseWithAI,
    },
  };
  return { g, deps };
}
const parseReq = (body: unknown, method = 'POST') =>
  new Request('http://kong/functions/v1/ai-parse', { method, headers: { 'content-type': 'application/json', 'x-app-version': '4.0.0' }, body: method === 'POST' ? JSON.stringify(body) : null });
const BODY = { text: '明天下午三点和 NEOX 对片', now: NOW, tz: 'Asia/Seoul', locale: 'zh-CN', projects: ['NEOX'] };
const call = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

describe('ai-parse', () => {
  it('Q2：成功回 {intent: record, confidence: 1, items, quota_left}，过客户端的 aiResponse；扣 1 次', async () => {
    const { g, deps } = parseDeps();
    const r = await call(await parseHandle(parseReq(BODY), deps));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ intent: 'record', confidence: 1, quota_left: 49 });
    expect(aiResponse.safeParse(r.body).success).toBe(true);
    expect(used(g, `ai:${UA}`)).toBe(1);
    const sent = g.provider.stub.calls[0];
    expect(JSON.stringify(sent?.parts)).toContain('NEOX');
  });
  it('只收 POST；JWT 不过原样回；请求体不合格、时区不认识都 400，超过 16 KB 边读边计数回 413，不调服务商', async () => {
    const { g, deps } = parseDeps();
    expect((await parseHandle(parseReq(null, 'GET'), deps)).status).toBe(405);
    const denied = new Response('{"error":"unauthorized"}', { status: 401 });
    expect(await parseHandle(parseReq(BODY), { ...deps, authenticate: async () => ({ ok: false, response: denied }) })).toBe(denied);
    for (const b of [{ ...BODY, text: '' }, { ...BODY, tz: 'Mars/Base' }, { ...BODY, now: -1 }, 'not-an-object']) {
      expect((await parseHandle(parseReq(b), deps)).status).toBe(400);
    }
    expect((await parseHandle(parseReq({ ...BODY, text: 'x'.repeat(MAX_BODY + 1) }), deps)).status).toBe(413);
    // 分块上传、不带 Content-Length：读到超过 16 KB 就中断（安全审建议 1）
    const t = trickle(4096, 100);
    const chunked = new Request('http://kong/functions/v1/ai-parse', { method: 'POST', body: t.stream, duplex: 'half' } as RequestInit);
    expect((await parseHandle(chunked, deps)).status).toBe(413);
    expect(t.sent()).toBeLessThan(10);
    expect(g.provider.stub.calls.length).toBe(0);
  });
  // 代码审 M4：鉴权失败原样转发（假鉴权）；没有 profiles 行由 supabase/tests/store-it/ai-fns-store.it.ts 真 requireActiveUser 覆盖
  it('TC-B1-10 ai-parse：管理员停用的账号回 403 account_disabled（鉴权失败原样转发），不调服务商、不扣次数', async () => {
    const { g, deps } = parseDeps();
    const r = await call(await parseHandle(parseReq(BODY), { ...deps, authenticate: async () => ({ ok: false as const, response: new Response('{"error":"account_disabled"}', { status: 403 }) }) }));
    expect(r).toEqual({ status: 403, body: { error: 'account_disabled' } });
    expect([g.provider.stub.calls.length, g.counts.size]).toEqual([0, 0]);
  });
  it('TC-B3-25：没同意 → consent_required，服务商 0 次、不扣次数', async () => {
    const { g, deps } = parseDeps({ consent: false });
    expect(await call(await parseHandle(parseReq(BODY), deps))).toEqual({ status: 200, body: { consent_required: true } });
    expect([g.provider.stub.calls.length, used(g, 'ai:')]).toEqual([0, 0]);
  });
  it('scope = vault：B3 一律 fallback vault_ai_off，不调服务商、不扣次数', async () => {
    const { g, deps } = parseDeps();
    expect((await call(await parseHandle(parseReq({ ...BODY, scope: 'vault' }), deps))).body).toEqual({ fallback: true, reason: 'vault_ai_off' });
    expect([g.provider.stub.calls.length, g.counts.size]).toEqual([0, 0]);
  });
  it('TC-B3-26：anniv 关着时 responseSchema 里没有 anniv，AI 硬给的 anniv 算 invalid → fallback、退回次数、只把原因写 logs', async () => {
    const anniv = { kind: 'anniv', title: '妈妈生日', anniv: { type: 'birthday', calendar: 'solar', month: 11, day: 5 } };
    const { g, deps } = parseDeps({ features: ['event', 'todo'], reply: () => okJson({ items: [anniv] }) });
    expect((await call(await parseHandle(parseReq({ ...BODY, text: '下个月 5 号妈妈生日' }), deps))).body).toEqual({ fallback: true, reason: 'invalid' });
    expect(JSON.stringify(g.provider.stub.calls[0]?.schema)).not.toContain('anniv');
    expect(used(g, 'ai:')).toBe(0);
    expect(g.invalid).toEqual([{ userId: UA, src: 'ai-parse', reasons: ['not_whitelisted'] }]);
  });
  it('TC-B3-50、06、07：缺 basis、额度用完、超时、服务商抛错都 fallback 并退回预扣；quota 写 exhausted_until', async () => {
    const cases = [
      [() => okJson({ items: [{ ...EV, date_basis: null }] }), 'invalid'],
      [() => ({ ok: false as const, reason: 'quota' as const, status: 429 }), 'quota'],
      [() => ({ ok: false as const, reason: 'timeout' as const }), 'timeout'],
      [() => { throw new Error('boom'); }, 'error'],
    ] as const;
    for (const [reply, reason] of cases) {
      const { g, deps } = parseDeps({ reply });
      expect((await call(await parseHandle(parseReq(BODY), deps))).body, reason).toEqual({ fallback: true, reason });
      expect(used(g, 'ai:'), reason).toBe(0);
      expect(g.exhaustedAt.length, reason).toBe(reason === 'quota' ? 1 : 0);
    }
  });
  it('TC-B3-42：AI 带的 confirm 不采用，由服务器重算', async () => {
    const { deps } = parseDeps({ reply: () => okJson({ items: [{ ...EV, date: '2026-10-01', date_basis: 'md', confirm: { past: '2000-01-01', next: '2000-01-02' } }] }) });
    const r = await call(await parseHandle(parseReq(BODY), deps));
    expect((r.body['items'] as AiItem[])[0]?.confirm).toEqual({ past: '2026-10-01', next: '2027-10-01' });
  });
});

function voiceDeps(o: GateOpts = {}) {
  const g = fakeGate({ reply: () => okJson({ transcript: '明天下午三点开会', items: [EV] }), ...o });
  const fails: { userId: string; code: string; fields: string[] }[] = [];
  const deps: VoiceDeps<AiItem> = {
    ...g, authenticate: authed, logic: { maxAudio: AI_AUDIO_MAX_BYTES, audioType, normLocale, normProjects, isValidTz, checkDefaultDay, voiceWithAI },
    async logFail(userId, code, fields) {
      fails.push({ userId, code, fields });
    },
  };
  return { g, deps, fails };
}
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function voiceReq(body: BodyInit | null, h: Record<string, string> = {}) {
  return new Request('http://kong/functions/v1/ai-voice', {
    method: 'POST',
    headers: { 'content-type': 'audio/webm;codecs=opus', 'x-now': String(NOW), 'x-tz': 'Asia/Seoul', 'x-locale': 'ko', ...h },
    body,
    ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
  } as RequestInit);
}
/** 不带 Content-Length、一块一块吐的流；记下被读了多少块 */
function trickle(chunk: number, n: number) {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent >= n) return c.close();
      sent++;
      c.enqueue(new Uint8Array(chunk));
    },
  });
  return { stream, sent: () => sent };
}

describe('ai-voice：失败分支写 logs 表（架构审第九节第 2 条）', () => {
  const run = async (o: GateOpts, extra: Partial<VoiceDeps<AiItem>> = {}, size = 5) => {
    const v = voiceDeps(o);
    const r = await call(await voiceHandle(voiceReq(new Uint8Array(size)), { ...v.deps, ...extra }));
    return { ...v, r };
  };
  /** 只准有固定错误码和三种字段；不带转写、正文、请求头 */
  const clean = (fails: { fields: string[] }[]) => {
    for (const f of fails) for (const x of f.fields) expect(x).toMatch(/^(status=\d{3}|type=[A-Za-z]{1,40}|bytes=(<16k|16k-64k|64k-256k|256k-600k))$/);
  };
  it('Gemini 拒收（400）：写一行 ai_error，带 HTTP 状态和字节数区间；回 ai_failed、退回次数', async () => {
    const { r, fails, g } = await run({ reply: () => ({ ok: false, reason: 'error', status: 400 }) }, {}, 20 * 1024);
    expect(r.body).toEqual({ ai_failed: true, reason: 'error' });
    expect(fails).toEqual([{ userId: UA, code: 'ai_error', fields: ['status=400', 'bytes=16k-64k'] }]);
    expect(used(g, 'ai:')).toBe(0);
    clean(fails);
  });
  it('超时：写 ai_timeout，带异常类型名', async () => {
    const { fails } = await run({ reply: () => ({ ok: false, reason: 'timeout', errName: 'AbortError' }) });
    expect(fails).toEqual([{ userId: UA, code: 'ai_timeout', fields: ['type=AbortError', 'bytes=<16k'] }]);
  });
  it('voiceWithAI 自己抛异常：写 ai_error，只记类型名，不记 message', async () => {
    const { r, fails } = await run({}, { logic: { maxAudio: AI_AUDIO_MAX_BYTES, audioType, normLocale, normProjects, isValidTz, checkDefaultDay, voiceWithAI: async () => { throw new TypeError('明天下午三点开会 secret'); } } });
    expect(r.body).toEqual({ ai_failed: true, reason: 'error' });
    expect(fails).toEqual([{ userId: UA, code: 'ai_error', fields: ['type=TypeError', 'bytes=<16k'] }]);
    expect(JSON.stringify(fails)).not.toContain('secret');
  });
  it('额度用完：Gemini 429 写 ai_quota；个人额度用完写 quota_out；全站额度标记还没过期写 quota_exhausted；每分钟限流写 rate_limited', async () => {
    // 额度类型（11-13）：服务商没带类型的按 unknown 记；带了照写
    expect((await run({ reply: () => ({ ok: false, reason: 'quota', status: 429 }) })).fails.map((f) => [f.code, f.fields])).toEqual([['ai_quota', ['status=429', 'kind=unknown', 'bytes=<16k']]]);
    expect((await run({ reply: () => ({ ok: false, reason: 'quota', status: 429, quotaKind: 'day', retryMs: 1000 }) })).fails.map((f) => f.fields)).toEqual([['status=429', 'kind=day', 'bytes=<16k']]);
    const out = await run({ config: { per_user_daily: 0 } });
    expect(out.r.body).toEqual({ quota_out: true, quota_left: 0 });
    expect(out.fails.map((f) => f.code)).toEqual(['quota_out']);
    expect((await run({ exhaustedUntil: Date.UTC(2026, 9, 29) })).fails.map((f) => f.code)).toEqual(['quota_exhausted']);
    expect((await run({ config: { global_daily: 0 } })).fails.map((f) => f.code)).toEqual(['global_quota_out']);
    const rl = await run({ minuteLimitHit: true });
    expect([rl.r.status, rl.fails.map((f) => f.code)]).toEqual([429, ['rate_limited']]);
  });
  it('谷歌额度停用中（门第 ⑤ 步）：quota_exhausted 带 kind=minute|day；每分钟的给客户端回 {fallback, error}，每天的回 {fallback, quota}', async () => {
    const m = await run({ exhaustedUntil: NOW + 12_000 });
    expect([m.r.body, m.fails]).toEqual([{ fallback: true, reason: 'error' }, [{ userId: UA, code: 'quota_exhausted', fields: ['kind=minute', 'bytes=<16k'] }]]);
    const d = await run({ exhaustedUntil: Date.UTC(2026, 9, 29) });
    expect([d.r.body, d.fails]).toEqual([{ fallback: true, reason: 'quota' }, [{ userId: UA, code: 'quota_exhausted', fields: ['kind=day', 'bytes=<16k'] }]]);
  });
  it('本次撞了每分钟限额：给客户端回 ai_failed error（不是 quota），logs 照旧 ai_quota kind=minute', async () => {
    const { r, fails } = await run({ reply: () => ({ ok: false, reason: 'quota', status: 429, quotaKind: 'minute', retryMs: 12_000 }) });
    expect([r.body, fails.map((f) => [f.code, f.fields])]).toEqual([{ ai_failed: true, reason: 'error' }, [['ai_quota', ['status=429', 'kind=minute', 'bytes=<16k']]]]);
  });
  it('计数出错：预扣抛错写 store_failed（503）；退回抛错写 ai_* 和 settle_failed，照样回 ai_failed', async () => {
    const v1 = voiceDeps();
    const r1 = await call(await voiceHandle(voiceReq(new Uint8Array(5)), { ...v1.deps, quota: { take: async () => { throw new Error('db'); }, refund: async () => {} } }));
    expect([r1.status, v1.fails.map((f) => f.code)]).toEqual([503, ['store_failed']]);
    const v2 = voiceDeps({ reply: () => ({ ok: false, reason: 'error', status: 500 }) });
    const r2 = await call(await voiceHandle(voiceReq(new Uint8Array(5)), { ...v2.deps, quota: { take: async () => 1, refund: async () => { throw new Error('db'); } } }));
    expect(r2.body).toEqual({ ai_failed: true, reason: 'error' });
    expect(v2.fails.map((f) => f.code)).toEqual(['ai_error', 'settle_failed']);
  });
  it('没同意、类型开关关着、成功都不写；写 logs 失败不影响回答', async () => {
    for (const o of [{ consent: false }, { features: [] }, {}] as GateOpts[]) expect((await run(o)).fails, JSON.stringify(o)).toEqual([]);
    const v = voiceDeps({ reply: () => ({ ok: false, reason: 'timeout' }) });
    const r = await call(await voiceHandle(voiceReq(new Uint8Array(5)), { ...v.deps, logFail: async () => { throw new Error('db'); } }));
    expect(r.body).toEqual({ ai_failed: true, reason: 'timeout' });
    expect(v.g.logs).toContain('log_write_failed');
  });
  it('字节数区间', () => {
    expect([0, 16 * 1024 - 1, 16 * 1024, 64 * 1024, 256 * 1024, AI_AUDIO_MAX_BYTES].map(bytesBucket)).toEqual(['<16k', '<16k', '16k-64k', '64k-256k', '256k-600k', '256k-600k']);
  });
});

describe('ai-voice', () => {
  it('Content-Type 先去参数再比：audio/webm;codecs=opus 通过，转交服务商用 audio/webm；不在 4 种里 415、不调服务商', async () => {
    expect([audioType('audio/webm;codecs=opus'), audioType(' AUDIO/MP4 '), audioType('audio/ogg'), audioType(null), audioType('video/webm')]).toEqual(['audio/webm', 'audio/mp4', null, null, null]);
    const { g, deps } = voiceDeps();
    const ok = await call(await voiceHandle(voiceReq(new Uint8Array(100)), deps));
    expect(ok.body).toMatchObject({ intent: 'record', confidence: 1, transcript: '明天下午三点开会', quota_left: 49 });
    expect(aiResponse.safeParse(ok.body).success).toBe(true);
    const part = g.provider.stub.calls[0]?.parts[1];
    expect(part && 'inlineData' in part && part.inlineData.mimeType).toBe('audio/webm');
    const before = g.provider.stub.calls.length;
    expect((await voiceHandle(voiceReq(new Uint8Array(10), { 'content-type': 'audio/ogg' }), deps)).status).toBe(415);
    expect(g.provider.stub.calls.length).toBe(before);
  });
  it('TC-B3-24：超过 600 KB 边读边计数中断 413（没有 Content-Length 也一样），不调服务商、不扣次数', async () => {
    const { g, deps } = voiceDeps();
    const t = trickle(64 * 1024, 100);
    expect((await voiceHandle(voiceReq(t.stream), deps)).status).toBe(413);
    expect(t.sent()).toBeLessThan(100);
    expect(t.sent()).toBeLessThanOrEqual(Math.ceil(AI_AUDIO_MAX_BYTES / (64 * 1024)) + 2);
    expect((await voiceHandle(voiceReq(new Uint8Array(AI_AUDIO_MAX_BYTES + 1)), deps)).status).toBe(413);
    expect(await readCapped(voiceReq(new Uint8Array(AI_AUDIO_MAX_BYTES)), AI_AUDIO_MAX_BYTES)).toHaveLength(AI_AUDIO_MAX_BYTES);
    expect([g.provider.stub.calls.length, g.counts.size]).toEqual([0, 0]);
  });
  // 代码审 M4：同上
  it('TC-B1-10 ai-voice：管理员停用的账号回 403 account_disabled（鉴权失败原样转发），不读音频、不调服务商、不扣次数', async () => {
    const { g, deps } = voiceDeps();
    const r = await call(await voiceHandle(voiceReq(new Uint8Array(5)), { ...deps, authenticate: async () => ({ ok: false as const, response: new Response('{"error":"account_disabled"}', { status: 403 }) }) }));
    expect(r).toEqual({ status: 403, body: { error: 'account_disabled' } });
    expect([g.provider.stub.calls.length, g.counts.size]).toEqual([0, 0]);
  });
  it('空音频、缺 X-Now、时区不认识、X-Scope 不认识都 400', async () => {
    const { deps } = voiceDeps();
    expect((await voiceHandle(voiceReq(new Uint8Array(0)), deps)).status).toBe(400);
    for (const h of [{ 'x-now': 'abc' }, { 'x-tz': 'Nowhere' }, { 'x-scope': 'other' }]) expect((await voiceHandle(voiceReq(new Uint8Array(5), h), deps)).status).toBe(400);
  });
  it('M3：X-Projects 是 base64url 的 UTF-8 JSON；超 4 KB 按项截断、解不开当没给（不拒收）', async () => {
    expect(decodeProjects(b64url(JSON.stringify(['柠檬', 'NEOX'])))).toEqual(['柠檬', 'NEOX']);
    expect(decodeProjects('%%%')).toEqual([]);
    expect(decodeProjects(b64url('{"a":1}'))).toEqual([]);
    // 代码审建议 6：超 4 KB 按项截断，留下截断处之前完整的项（不再整个丢掉）
    expect(decodeProjects(b64url(JSON.stringify(['x'.repeat(MAX_PROJECTS_HEADER)])))).toEqual([]);   // 只有一项、本身就超：没有完整的项
    const many = Array.from({ length: 400 }, (_, i) => `项目${i}`);
    const kept = decodeProjects(b64url(JSON.stringify(many)));
    expect(kept.length).toBeGreaterThan(50);
    expect(kept.length).toBeLessThan(400);
    expect(kept).toEqual(many.slice(0, kept.length));
    expect(b64url(JSON.stringify(many)).length).toBeGreaterThan(MAX_PROJECTS_HEADER);
    const { g, deps } = voiceDeps();
    await voiceHandle(voiceReq(new Uint8Array(5), { 'x-projects': b64url(JSON.stringify(['柠檬'])) }), deps);
    expect(JSON.stringify(g.provider.stub.calls[0]?.parts[0])).toContain('柠檬');
    expect((await voiceHandle(voiceReq(new Uint8Array(5), { 'x-projects': '!!!' }), deps)).status).toBe(200);
  });
  it('TC-B3-25：没同意 → consent_required、服务商 0 次；失败回 ai_failed 并退回；vault 回 vault_ai_off', async () => {
    const no = voiceDeps({ consent: false });
    expect((await call(await voiceHandle(voiceReq(new Uint8Array(5)), no.deps))).body).toEqual({ consent_required: true });
    expect(no.g.provider.stub.calls.length).toBe(0);
    const bad = voiceDeps({ reply: () => ({ ok: false, reason: 'timeout' }) });
    expect((await call(await voiceHandle(voiceReq(new Uint8Array(5)), bad.deps))).body).toEqual({ ai_failed: true, reason: 'timeout' });
    expect(used(bad.g, 'ai:')).toBe(0);
    const v = voiceDeps();
    expect((await call(await voiceHandle(voiceReq(new Uint8Array(5), { 'x-scope': 'vault' }), v.deps))).body).toEqual({ fallback: true, reason: 'vault_ai_off' });
    expect(v.g.provider.stub.calls.length).toBe(0);
  });
});
