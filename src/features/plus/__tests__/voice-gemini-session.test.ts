// 按住“＋”挂 Gemini 实时转写时的整条控制器流程（data/voice-session.ts + voice-rec.ts + voice-gemini.ts + voice-pending.ts；不渲染界面）：
// 录音器、音频上下文、令牌、Live 会话、ai-voice、ai-parse、写库都用桩。覆盖 11-24 评审第 2、4 条和负责人 11-24“松手马上用已出的字存”：
// • 出了字但写库失败：录音留着，提示条是“AI 没回应 · 重试”，点重试上传这段录音、记下
// • 出了字：当场存，后台只把录音交 ai-voice 一次、不调 ai-parse（一句话只扣一次额度）；本机拆不出条目也不当场等 AI，已出的字整句存成今天的一条待办
// • 令牌回了“今天用完”：不上传录音，按 ai-voice 回同样结果的收法收尾（记今天用完、剩 0 次，提示条 quota）
import { afterEach, beforeEach, describe, expect, it, onTestFailed, vi } from 'vitest';
import { msAt } from '../../../../shared/core/date.ts';
import { clock } from '../../../platform/clock.ts';
import type { LiveEnd, LiveSession } from '../../../platform/live-transcribe.ts';
import { MIC_PERM_KEY, rememberMicResult } from '../../../platform/perm-mic.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import type { Draft } from '../../../core/cache.ts';
import type { WriteResult } from '../../../core/write.ts';
import { quotaResetAt } from '../../../../shared/logic/ai-quota.ts';
import type { Writer } from '../data/capture-save.ts';
import type { LiveTokenRes } from '../data/live-token-api.ts';
import type * as Quota from '../data/quota.ts';
import type * as TypeFlow from '../data/type-flow.ts';
import { pendText } from '../hooks/pending-text.ts';
import { createVoiceSession, type VoiceSession } from '../data/voice-session.ts';

const fx = vi.hoisted(() => ({
  left: [] as number[],
  noLocal: false,
  aiOn: [] as boolean[],
  /** 录音器 stop() 交出的结局：null 正常交出录音；给了就按这个失败；stopThrow 让 stop() 直接抛错 */
  stopEnd: null as null | { ok: false; fail: string },
  stopThrow: false,
  /** 会话收尾交出的字：空串 = 没出字，走占位、整段上传 */
  say: '买猫砂',
  /** 本机记的“今天用完”（quotaOutToday）：默认没用完 */
  quotaOut: (_now: number): boolean => false,
  quotaReads: 0,
}));
vi.mock('../../../platform/live-audio.ts', () => ({
  liveSupported: () => true,
  geminiLiveOn: () => true,
  openAudioCtx: () => ({ state: 'running' }),
  closeAudioCtx: () => undefined,
}));
vi.mock('../../../platform/recorder.ts', () => ({
  requestMic: async () => 'granted',
  startRecorder: async (o: { onStream?: (s: MediaStream) => void }) => {
    o.onStream?.({} as MediaStream);
    return {
      ok: true,
      rec: {
        elapsed: () => 2000,
        level: () => 0.4,
        stop: async () => {
          if (fx.stopThrow) throw new Error('boom');
          return fx.stopEnd ?? { ok: true, auto: false, clip: { blob: new Blob([new Uint8Array(2000)], { type: 'audio/mp4' }), mime: 'audio/mp4', ms: 2000 } };
        },
      },
    };
  },
}));
vi.mock('../data/quota.ts', async (orig) => ({
  ...(await orig<typeof Quota>()),
  quotaOutToday: async (now: number) => {
    fx.quotaReads += 1;
    return fx.quotaOut(now);
  },
  rememberQuotaLeft: async (n: number) => void fx.left.push(n),
}));
// 本机一条都拆不出来（noLocal）：planText 和整段上传回来的 planLocal 都拆不出；每次 planText 开没开 AI 记在 aiOn（开了就会调 ai-parse、扣次数）
vi.mock('../data/type-flow.ts', async (orig) => {
  const m = await orig<typeof TypeFlow>();
  const none = { recur: false, arrange: false, bad_day: null };
  return {
    ...m,
    planText: async (...args: Parameters<typeof m.planText>) => {
      fx.aiOn.push(args[2].aiOn);
      if (!fx.noLocal) return m.planText(...args);
      return { quotaOut: false, plan: { status: 'saved', origin: 'rule', items: [], hints: none, quotaLeft: null, aiReason: null, ask: null, alt: null } };
    },
    planLocal: (...args: Parameters<typeof m.planLocal>) => {
      const r = m.planLocal(...args);
      return fx.noLocal ? { ...r, result: { ...r.result, items: [] } } : r;
    },
  };
});

const NOW = msAt('2026-11-24', 12 * 60, 'UTC');
const ITEM = {
  kind: 'todo', title: '买猫砂', date: null, time: null, duration_min: null, due: null, important: false,
  project: null, body: null, short: null, date_basis: null, anniv: null, confirm: null,
};
const VOICE_OK = { intent: 'record', confidence: 1, transcript: '买猫砂', quota_left: 41, items: [ITEM] };
const TOK: LiveTokenRes = { ok: true, t: { token: 'auth_tokens/x', api: 'v1beta', setup: {} } };
const STATS = { connMs: 300, firstMs: 900, len: 3, capMs: 2000, sentMs: 2000, audioAt: null, backlogMs: 0, nInterim: 1, nFinal: 1, nModel: 0 };

let log: string[] = [];
let s: VoiceSession | null = null;

/** 本机库 drafts 仓的桩（占位留着的录音和 AI 结果存在这里） */
function memDrafts() {
  const m = new Map<string, Draft>();
  return {
    m,
    getDraft: async (id: string) => m.get(id),
    putDraft: async (d: Draft) => void m.set(d.id, d),
    deleteDraft: async (id: string) => void m.delete(id),
    allDrafts: async () => [...m.values()],
  };
}

function setup(o: { token?: LiveTokenRes; failFirstWrite?: boolean; drafts?: ReturnType<typeof memDrafts> } = {}) {
  let n = 0;
  const writer = {
    insert: vi.fn<Writer['insert']>(async (): Promise<WriteResult> => (o.failFirstWrite && n++ === 0 ? { ok: false, reason: 'quota' } : { ok: true, item: null })),
    patch: vi.fn<Writer['patch']>(async () => ({ ok: true, item: null })),
  };
  const callVoice = vi.fn(async (): Promise<unknown> => VOICE_OK);
  const callAi = vi.fn(async () => VOICE_OK);
  const sess = {
    connect: vi.fn(),
    fail: vi.fn(),
    level: () => 0.5,
    finish: vi.fn(async (): Promise<LiveEnd> => ({ ok: true, text: fx.say, stats: STATS })),
    close: vi.fn(),
  };
  s = createVoiceSession({
    callVoice,
    callAi,
    writer,
    online: () => true,
    live: { token: async () => o.token ?? TOK, open: async () => sess as unknown as LiveSession },
    ...(o.drafts ? { drafts: o.drafts } : {}),
  } as Parameters<typeof createVoiceSession>[0]);
  s.bind({ ctx: () => ({ now: NOW, tz: 'Asia/Seoul', locale: 'zh', projects: [], day: null }), aiOn: () => true, lang: 'zh-CN', pend: pendText('zh-CN') });
  return { s, writer, callVoice, callAi, sess };
}
const settle = () => new Promise<void>((ok) => setTimeout(ok, 30));
/** 按下、按满（开录）、松手 */
async function sayOnce(v: VoiceSession): Promise<void> {
  v.down();
  expect(v.start()).toBe(true);
  await settle();
  expect(v.view().status).toBe('recording');
  v.finish();
  await settle();
}

beforeEach(() => {
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  rememberMicResult('granted');
  fx.left = [];
  fx.noLocal = false;
  fx.aiOn = [];
  fx.stopEnd = null;
  fx.stopThrow = false;
  fx.say = '买猫砂';
  fx.quotaOut = () => false;
  fx.quotaReads = 0;
  log = [];
  (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => log.push(l) };
  onTestFailed(() => console.log(['运行日志：', ...log].join('\n')));
});
afterEach(() => {
  s?.dispose();
  s = null;
  localStorage.removeItem(MIC_PERM_KEY);
  delete (globalThis as Record<string, unknown>)[RL_SLOT];
  vi.restoreAllMocks();
});

describe('Gemini 实时转写：出了字没存上，录音不丢（评审第 4 条）', () => {
  it('写库失败：提示条“AI 没回应 · 重试”，录音留着；点重试上传这段录音、记下', async () => {
    const { s: v, writer, callVoice, sess } = setup({ failFirstWrite: true });
    await sayOnce(v);
    expect(sess.finish, '松手那一刻开始收尾，只收一次').toHaveBeenCalledTimes(1);
    expect(callVoice, '没存上就不在后台整理（录音留给“重试”）').not.toHaveBeenCalled();
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(v.view().status).toBe('ai_failed');
    expect(v.view().note).toBe('ai_failed');
    expect(log).toContain('voice rec keep bytes=2000');
    v.retry();
    await settle();
    expect(callVoice, '重试上传的是这段录音').toHaveBeenCalledTimes(1);
    expect(writer.insert).toHaveBeenCalledTimes(2);
    expect(v.view().status).toBe('saved');
  });

});

describe('Gemini 实时转写：松手马上用已出的字存，后台用录音补（负责人 11-24）', () => {
  it('出了字：当场按本机规则存、不开 AI；后台只把这段录音交 ai-voice 一次，不调 ai-parse（一句话只扣一次）；日志带松手到存好的毫秒', async () => {
    const { s: v, writer, callVoice, callAi } = setup();
    await sayOnce(v);
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(v.view().status).toBe('saved');
    expect(fx.aiOn, '先存那一步不开 AI').toEqual([false]);
    expect(callVoice, '后台交 ai-voice 一次').toHaveBeenCalledTimes(1);
    expect((callVoice.mock.calls[0] as unknown[] | undefined)?.[0]).toMatchObject({ audio: expect.any(Blob) });
    expect(callAi, '不再调 ai-parse').not.toHaveBeenCalled();
    expect(log.some((l) => /^voice saved path=text out=ok n=1 bytes=\d+ ms=\d+$/.test(l))).toBe(true);
    expect(log.some((l) => /^voice tidy path=text out=\w+ ms=\d+ total_ms=\d+$/.test(l))).toBe(true);
  });

  it('本机拆不出条目：不当场等 AI，已出的字整句存成今天的一条待办；后台 ai-voice 拆出来的不一样就换掉', async () => {
    fx.noLocal = true;
    const { s: v, writer, callVoice, callAi } = setup();
    await sayOnce(v);
    const first = writer.insert.mock.calls[0]?.[1] as { title: string; due: string } | undefined;
    expect(first).toMatchObject({ title: '买猫砂', due: '2026-11-24' });
    expect(fx.aiOn, '没有当场开 AI').toEqual([false]);
    expect(callAi).not.toHaveBeenCalled();
    expect(callVoice).toHaveBeenCalledTimes(1);
    expect(log.some((l) => /^voice saved path=whole out=ok n=1 bytes=\d+ ms=\d+$/.test(l))).toBe(true);
    await settle();
    expect(log.some((l) => /^voice tidy path=text out=replaced /.test(l))).toBe(true);
  });

  it('后台 ai-voice 失败：先存的留着，不出“重试”', async () => {
    const { s: v, writer, callVoice } = setup();
    callVoice.mockImplementation(async () => ({ ai_failed: true, reason: 'error' }) as never);
    await sayOnce(v);
    await settle();
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(writer.patch, '没撤先存的').not.toHaveBeenCalled();
    expect(v.view().note).toBeNull();
    expect(log.some((l) => /^voice tidy path=text out=failed_error /.test(l))).toBe(true);
  });
});

describe('Gemini 实时转写：令牌回了今天用完（评审第 2 条；负责人 11-24 不让人白说）', () => {
  it('令牌一回就当场停录、不等松手：不上传录音、不等 Gemini；记今天用完、剩 0 次，提示条 quota；下次按下直接挡、不开录', async () => {
    const { s: v, callVoice, sess } = setup({ token: { ok: false, why: 'quota_out' } });
    v.down();
    expect(v.start()).toBe(true);
    await settle();
    expect(v.view().capturing, '还没松手就收起').toBe(false);
    expect(v.view().note).toBe('quota');
    expect(callVoice).not.toHaveBeenCalled();
    expect(sess.finish).not.toHaveBeenCalled();
    expect(fx.left).toEqual([0]);
    expect(log.some((l) => l.startsWith('voice rec stop_now why=quota_out'))).toBe(true);
    v.finish();
    v.down();
    expect(v.start()).toBe(true);
    await settle();
    expect(v.view().capturing, '第二次不开录').toBe(false);
    expect(v.view().note).toBe('quota');
    expect(log.some((l) => /^voice hold start .* route=quota gm=on$/.test(l))).toBe(true);
  });
});

describe('AI 没开：按下那一刻就挡（负责人 11-24）', () => {
  it('不开录音器、不要令牌，提示条 ai_off', async () => {
    const { s: v, callVoice } = setup();
    v.bind({ ctx: () => ({ now: NOW, tz: 'Asia/Seoul', locale: 'zh', projects: [], day: null }), aiOn: () => false, lang: 'zh-CN', pend: pendText('zh-CN') });
    v.down();
    expect(v.start()).toBe(true);
    await settle();
    expect(v.view().capturing).toBe(false);
    expect(v.view().note).toBe('ai_off');
    expect(callVoice).not.toHaveBeenCalled();
    expect(log.some((l) => /^voice hold start .* route=off gm=on$/.test(l))).toBe(true);
    expect(log.some((l) => l.startsWith('voice gem begin')), '没开会话').toBe(false);
  });
});

// 11-24 整块评审核过的几条 bug（每条先失败、后通过）
const PH = '语音记录 · 整理中';
const PAST = { ...ITEM, title: '交房租', due: '2026-10-30', date_basis: 'md', confirm: { past: '2026-10-30', next: '2027-10-30' } };
/** 写进去的第几条（整行） */
const row = (w: { insert: { mock: { calls: unknown[][] } } }, i: number) => w.insert.mock.calls[i]?.[1] as { id: string; title: string };
/** 撤过（undo）的 id */
const undone = (w: { patch: { mock: { calls: unknown[][] } } }) => w.patch.mock.calls.filter((c) => (c[2] as { undone?: boolean }).undone === true).map((c) => c[1]);
/** ai-voice 先卡住，测试里放开 */
function heldVoice(callVoice: ReturnType<typeof setup>['callVoice']) {
  const box: { open: (v: unknown) => void } = { open: () => undefined };
  callVoice.mockImplementation(() => new Promise((ok) => (box.open = ok)));
  return box;
}

describe('评审 bug：录音器停不下来、停录抛错', () => {
  it('第 1 条：录音器停止失败但会话里已经出了字：照样把字取出来存下；没有录音就不排后台整理、不扣额度', async () => {
    fx.stopEnd = { ok: false, fail: 'empty' };
    const { s: v, writer, callVoice, sess } = setup();
    await sayOnce(v);
    expect(sess.finish).toHaveBeenCalledTimes(1);
    expect(writer.insert).toHaveBeenCalledTimes(1);
    expect(row(writer, 0).title).toBe('买猫砂');
    expect(v.view().status).toBe('saved');
    expect(callVoice, '没有录音：不排后台整理').not.toHaveBeenCalled();
    expect(fx.left, '不扣额度、不记剩余次数').toEqual([]);
  });

  it('第 4 条：停录那一步抛错：记日志、收尾，状态不卡在 uploading，提示“没保存上”', async () => {
    fx.stopThrow = true;
    const { s: v, writer } = setup();
    await sayOnce(v);
    expect(v.view().status).not.toBe('uploading');
    expect(v.view().note).toBe('not_saved');
    expect(writer.insert).not.toHaveBeenCalled();
    expect(log.some((l) => /^voice rec stop_err name=Error$/.test(l))).toBe(true);
  });
});

describe('评审 bug：占位那一路（一个字没出，先存“整理中”）', () => {
  beforeEach(() => {
    fx.say = '';
  });

  it('第 2 条：ai-voice 回 rule、本机一条都拆不出：有转写就把整句换进占位，不标“没整理成”', async () => {
    fx.noLocal = true;
    const { s: v, writer, callVoice } = setup();
    callVoice.mockResolvedValue({ ai_failed: true, reason: 'bad_json', transcript: '那个嗯周末' });
    await sayOnce(v);
    await settle();
    expect(row(writer, 0).title).toBe(PH);
    expect(row(writer, 1)?.title, '整句换进去').toBe('那个嗯周末');
    expect(undone(writer)).toEqual([row(writer, 0).id]);
    expect(v.pending.box.getState(), '不是“没整理成”').toEqual({});
  });

  it('第 2 条（重试那一路）：点重试回 rule、拆出 0 条：整句存成待办、撤掉占位', async () => {
    fx.noLocal = true;
    const { s: v, writer, callVoice } = setup();
    callVoice.mockResolvedValueOnce({ ai_failed: true, reason: 'error' });
    await sayOnce(v);
    await settle();
    const ph = row(writer, 0).id;
    expect(v.pending.box.getState()).toEqual({ [ph]: 'failed' });
    callVoice.mockResolvedValueOnce({ ai_failed: true, reason: 'bad_json', transcript: '那个嗯周末' });
    expect(await v.retryPending(ph)).toBe('started');
    await settle();
    expect(writer.insert.mock.calls.map((c) => (c[1] as unknown as { title: string }).title)).toEqual([PH, '那个嗯周末']);
    expect(undone(writer)).toEqual([ph]);
    expect(v.pending.box.getState()).toEqual({});
  });

  it('第 3、7 条：AI 结果里有要问的过去月日（skip_confirm）：结果跟着占位留下（drafts 里也有）；点重试不再调 AI、直接出确认行；没选就关掉，占位留着', async () => {
    const drafts = memDrafts();
    const { s: v, writer, callVoice } = setup({ drafts });
    callVoice.mockResolvedValue({ ...VOICE_OK, transcript: '10 月 30 号交房租', items: [PAST] });
    await sayOnce(v);
    await settle();
    const ph = row(writer, 0).id;
    expect(log.some((l) => / out=skip_confirm /.test(l))).toBe(true);
    expect(v.pending.box.getState()).toEqual({ [ph]: 'failed' });
    expect((drafts.m.get(`voice-pending:${ph}`)?.data as { res?: unknown } | undefined)?.res, 'drafts 里存了这次的结果').toMatchObject({ kind: 'record' });
    expect(await v.retryPending(ph)).toBe('started');
    await settle();
    expect(callVoice, '不再调 AI（这次已经扣过）').toHaveBeenCalledTimes(1);
    expect(v.view().status).toBe('confirming');
    expect(undone(writer), '还没选：占位不撤').toEqual([]);
    v.dismissConfirm();
    await settle();
    expect(undone(writer), '没选就关掉：占位留着').toEqual([]);
    expect(v.pending.box.getState()).toEqual({ [ph]: 'failed' });
  });

  it('第 7 条：重试出确认行，选完才撤掉占位', async () => {
    const { s: v, writer, callVoice } = setup();
    callVoice.mockResolvedValueOnce({ ai_failed: true, reason: 'error' });
    await sayOnce(v);
    await settle();
    const ph = row(writer, 0).id;
    callVoice.mockResolvedValueOnce({ ...VOICE_OK, transcript: '10 月 30 号交房租', items: [PAST] });
    expect(await v.retryPending(ph)).toBe('started');
    await settle();
    expect(v.view().status).toBe('confirming');
    expect(undone(writer), '确认行还在问：占位不撤').toEqual([]);
    await v.batch.choose('past');
    await settle();
    expect(undone(writer)).toEqual([ph]);
    expect(v.pending.box.getState()).toEqual({});
  });

  it('第 10 条：编辑页开着这一条时 AI 回来：不替换，结果留着给重试；提示条上点过“修改”（touch）也一样', async () => {
    for (const how of ['edit', 'touch'] as const) {
      const { s: v, writer, callVoice } = setup();
      const ai = heldVoice(callVoice);
      await sayOnce(v);
      const ph = row(writer, 0).id;
      const close = how === 'edit' ? v.batch.edit(ph) : (v.batch.touch(), () => undefined);
      ai.open(VOICE_OK);
      await settle();
      expect(writer.insert, `${how}：没换`).toHaveBeenCalledTimes(1);
      expect(log.some((l) => / out=skip_edited /.test(l)), how).toBe(true);
      expect(v.pending.box.getState()).toEqual({ [ph]: 'failed' });
      close();
      s?.dispose();
      log = [];
    }
  });
});

describe('评审 bug：额度用完的状态能同步过期（第 6 条）', () => {
  it('令牌回了今天用完，过了恢复时刻再按：按下那一刻就不再挡（不等异步重读）', async () => {
    const { s: v } = setup({ token: { ok: false, why: 'quota_out' } });
    v.down();
    v.start();
    await settle();
    expect(v.view().note).toBe('quota');
    v.closeNote();
    const later = quotaResetAt(NOW) + 1000;
    vi.mocked(clock.now).mockReturnValue(later);
    fx.quotaOut = (now) => now < quotaResetAt(NOW);
    v.down();
    expect(v.start()).toBe(true);
    await settle();
    expect(log.filter((l) => /^voice hold start /.test(l)).pop(), '过了恢复时刻：走录音').toMatch(/route=rec /);
  });

  it('回到前台（visibilitychange）：重读一次本机额度', async () => {
    const { s: v } = setup();
    const off = v.attach();
    await settle();
    const before = fx.quotaReads;
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(fx.quotaReads).toBe(before + 1);
    off();
  });
});
