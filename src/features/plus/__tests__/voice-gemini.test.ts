// 按住“＋”的 Gemini 实时转写挂点（data/voice-gemini.ts）：要令牌、接采音、出字进面板、松手那一刻开始收尾、出了字交回 { text }（存由 voice-rec.ts 做），
// 令牌回了今天用完 / 没同意按结果收尾不上传；令牌拿不到 / 超时 / 采音接不上 / 一个字没出交回录音上传；断线、积压、发出的音短一截时已出的字照样交回（后台录音补）；
// 丢掉时中止令牌请求、关连接和音频上下文
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveEnd, LiveOpts, LiveSession, LiveStats, LiveToken } from '../../../platform/live-transcribe.ts';
import type { RecEnd } from '../../../platform/recorder.ts';
import { RL_SLOT } from '../../../platform/run-log-api.ts';
import type { LiveTokenRes } from '../data/live-token-api.ts';
import { LIVE_TOKEN_WAIT_MS, createGeminiTap } from '../data/voice-gemini.ts';
import type { Attempt, VoiceCore } from '../data/voice-session.ts';

const fx = vi.hoisted(() => ({ ctx: { state: 'running' } as unknown, closed: [] as unknown[] }));
vi.mock('../../../platform/live-audio.ts', () => ({
  openAudioCtx: () => fx.ctx,
  closeAudioCtx: (c: unknown) => void fx.closed.push(c),
}));

const TOK: LiveTokenRes = { ok: true, t: { token: 'auth_tokens/x', api: 'v1beta', setup: {} } };
/** 时钟：录音器在 T_REC 开录，第一块音紧跟着到 */
const T_REC = 10_000;
const STATS: LiveStats = { connMs: 300, firstMs: 900, len: 3, capMs: 2000, sentMs: 2000, audioAt: T_REC + 40, backlogMs: 0, nInterim: 4, nFinal: 1, nModel: 0 };

/** 假会话：记下调用，finish 回给定的结局（没给 text 是空串） */
function fakeSess(end: ({ ok: true } | { ok: false; why: string }) & { text?: string }, stats: Partial<LiveStats> = {}) {
  const s = {
    opts: null as LiveOpts | null,
    connected: null as LiveToken | null,
    failed: null as string | null,
    closed: 0,
    connect: vi.fn((t: LiveToken) => void (s.connected = t)),
    fail: vi.fn((w: string) => void (s.failed = w)),
    level: () => 0.6,
    finish: vi.fn(async (): Promise<LiveEnd> => ({ text: '', ...end, stats: { ...STATS, ...stats } }) as LiveEnd),
    close: vi.fn(() => void s.closed++),
  };
  return s;
}

function core() {
  const sets: Record<string, unknown>[] = [];
  const st = { cur: null as Attempt | null, alive: true };
  const c = {
    d: () => ({ lang: 'zh-CN' }),
    current: () => st.cur,
    set: (p: Record<string, unknown>) => void sets.push(p),
    alive: () => st.alive,
  } as unknown as VoiceCore;
  return { c, sets, st };
}
const attempt = (): Attempt => ({ id: 1, ac: new AbortController(), rec: null, committed: false, droppedBy: null, from: 'voice' });
const recOk = (ms = 2000): RecEnd => ({ ok: true, clip: { blob: new Blob(['x']), mime: 'audio/mp4', ms }, auto: false });
const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

let lines: string[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  fx.closed = [];
  lines = [];
  (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
});
afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as Record<string, unknown>)[RL_SLOT];
});

interface RunOpts {
  sess?: ReturnType<typeof fakeSess>;
  token?: (l: string, s: AbortSignal) => Promise<LiveTokenRes>;
  openThrows?: boolean;
  recMs?: number;
}

/** 走一遍：begin → stream → （令牌）→ 录音器开录 started；settle 是松手后录音器交了结局 */
async function run(o: RunOpts = {}) {
  const { c, sets, st } = core();
  const sess = o.sess ?? fakeSess({ ok: true, text: ' 买猫砂 ' });
  const clock = { t: T_REC - 300 };
  const tap = createGeminiTap(
    c,
    {
      token: o.token ?? (async () => TOK),
      open: async (op) => {
        if (o.openThrows) throw Object.assign(new Error('x'), { name: 'NotSupportedError' });
        sess.opts = op;
        return sess as unknown as LiveSession;
      },
    },
    () => clock.t,
  );
  const a = attempt();
  st.cur = a;
  const stop = vi.fn();
  tap.begin(a, stop);
  expect(tap.level(), '还在接：平着').toBe(0);
  tap.stream({} as MediaStream);
  await flush();
  clock.t = T_REC;
  tap.started(a);
  return { tap, a, sess, sets, st, clock, stop, settle: (r: RecEnd = recOk(o.recMs)) => tap.settle(a, r) };
}

describe('Gemini 实时转写挂点', () => {
  it('令牌到了就连；出字进面板；松手出了字交回 { text }（去掉首尾空白），不上传；会话用同一个时钟', async () => {
    const r = await run();
    expect(r.sess.connected?.token).toBe('auth_tokens/x');
    expect(r.sess.opts?.now?.()).toBe(T_REC);
    expect(r.tap.level(), '声波用真实电平').toBe(0.6);
    r.sess.opts?.onText('买猫');
    expect(r.sets).toContainEqual({ live: '买猫' });
    expect(await r.settle()).toEqual({ text: '买猫砂' });
    expect(r.sess.close).toHaveBeenCalled();
    expect(fx.closed).toEqual([fx.ctx]);
    const end = lines.find((l) => l.startsWith('voice gem end'));
    expect(end).toMatch(/ok=1 conn_ms=300 first_ms=900 len=3 cap_ms=2000 sent_ms=2000 rec_ms=2000 head_ms=40 backlog_ms=0 n_interim=4 n_final=1 n_model=0 wait_ms=\d+/);
    expect(lines.join('\n'), '不记说的字').not.toMatch(/猫/);
  });

  it('评审第 5 条：松手那一刻（release）就开始收尾，录音器交了结局以后用同一个结果，不再 finish 第二次', async () => {
    const r = await run();
    r.tap.release(r.a);
    expect(r.sess.finish).toHaveBeenCalledTimes(1);
    expect(await r.settle()).toEqual({ text: '买猫砂' });
    expect(r.sess.finish).toHaveBeenCalledTimes(1);
  });

  it('评审第 2 条：令牌回了“今天用完”“没同意”：松手按这个结果收尾（不上传、不等 Gemini）；今天用完还当场交给录音这一路停录（负责人 11-24 不让人白说）', async () => {
    for (const [why, kind] of [['quota_out', 'quota_out'], ['consent', 'consent_required']] as const) {
      fx.closed = [];
      const r = await run({ token: async () => ({ ok: false, why }) });
      if (kind === 'quota_out') expect(r.stop, why).toHaveBeenCalledWith({ kind: 'quota_out' });
      else expect(r.stop, why).not.toHaveBeenCalled();
      expect(r.sess.failed).toBe(why);
      r.tap.release(r.a);
      expect(r.sess.finish, why).not.toHaveBeenCalled();
      expect(await r.settle(), why).toEqual({ res: { kind } });
      expect(lines).toContain(`voice gem stop why=${kind}`);
      expect(fx.closed).toHaveLength(1);
    }
  });

  it('令牌拿不到（服务器让退回）：会话标失败、声波交回录音器，松手交回上传', async () => {
    const r = await run({ token: async () => ({ ok: false, why: 'fb_live_quota' }) });
    expect(r.sess.failed).toBe('fb_live_quota');
    expect(r.sess.connect).not.toHaveBeenCalled();
    expect(await r.settle()).toBe('upload');
    expect(lines).toContain('voice gem off why=token_fb_live_quota');
    expect(lines).toContain('voice gem fallback why=token_fb_live_quota');
  });

  it('令牌等太久：LIVE_TOKEN_WAIT_MS 到了中止请求、算超时', async () => {
    const got: { sig: AbortSignal | null } = { sig: null };
    const r = await run({
      // 像 fetch 一样：被中止才抛
      token: (_l, s) =>
        new Promise((_, no) => {
          got.sig = s;
          s.addEventListener('abort', () => no(new Error('abort')));
        }),
    });
    await vi.advanceTimersByTimeAsync(LIVE_TOKEN_WAIT_MS + 5);
    expect(got.sig?.aborted).toBe(true);
    expect(r.sess.failed).toBe('timeout');
    expect(await r.settle()).toBe('upload');
  });

  it('评审第 2 条：收拾掉这一次时（松手了令牌还没回来）中止还没回来的令牌请求', async () => {
    const got: { sig: AbortSignal | null } = { sig: null };
    const r = await run({
      // 不理会中止的请求（最坏情况）：会话一直没连上，收尾回 not_ready
      sess: fakeSess({ ok: false, why: 'not_ready' }),
      token: (_l, s) =>
        new Promise(() => {
          got.sig = s;
        }),
    });
    expect(got.sig?.aborted).toBe(false);
    expect(await r.settle()).toBe('upload');
    expect(got.sig?.aborted).toBe(true);
  });

  it('采音接不上（worklet 加载失败）：声波交回录音器（-1），松手上传', async () => {
    const r = await run({ openThrows: true });
    expect(r.tap.level()).toBe(-1);
    expect(lines).toContain('voice gem off why=audio_NotSupportedError');
    expect(await r.settle()).toBe('upload');
  });

  it('断线、积压、没连上，又一个字没出：交回上传，日志带 finish 的原因', async () => {
    for (const why of ['close_1006', 'backlog', 'not_ready']) {
      const r = await run({ sess: fakeSess({ ok: false, why }) });
      expect(await r.settle()).toBe('upload');
      expect(lines).toContain(`voice gem fallback why=${why}`);
    }
  });

  it('断线、积压时已经出过字：半截字照样交回 { text }（负责人 11-24：最后几个字先少一点、后台录音补上）', async () => {
    for (const why of ['close_1006', 'backlog']) {
      const r = await run({ sess: fakeSess({ ok: false, why, text: '买猫' }) });
      expect(await r.settle()).toEqual({ text: '买猫' });
      expect(lines.findLast((l) => l.startsWith('voice gem end'))).toContain(`ok=0 why=${why}`);
    }
  });

  it('一个字都没有：交回上传', async () => {
    const r = await run({ sess: fakeSess({ ok: true, text: '  ' }) });
    expect(await r.settle()).toBe('upload');
    expect(lines).toContain('voice gem fallback why=empty');
  });

  it('发出去的音比录音短、开头缺一截：只记在日志里（sent_ms、head_ms），字照样交回（后台用完整录音补）', async () => {
    const r = await run({ sess: fakeSess({ ok: true, text: '买猫砂' }, { audioAt: T_REC + 1000, capMs: 3000, sentMs: 1500 }), recMs: 3000 });
    expect(await r.settle()).toEqual({ text: '买猫砂' });
    const end = lines.find((l) => l.startsWith('voice gem end'));
    expect(end).toContain('sent_ms=1500 rec_ms=3000 head_ms=1000');
    expect(lines.some((l) => l.startsWith('voice gem fallback')), '不退回上传').toBe(false);
  });

  it('评审第 1 条：录音器没交出录音但已出了字：照样交回 { text }（voice-rec 只存字）；一个字没出交回 upload 按原因提示', async () => {
    const r = await run();
    expect(await r.tap.settle(r.a, { ok: false, fail: 'empty' })).toEqual({ text: '买猫砂' });
    expect(r.sess.finish).toHaveBeenCalledTimes(1);
    expect(fx.closed).toHaveLength(1);
    expect(lines.find((l) => l.startsWith('voice gem end'))).toMatch(/rec_ms=-1/);
    const e = await run({ sess: fakeSess({ ok: true }) });
    expect(await e.tap.settle(e.a, { ok: false, fail: 'empty' })).toBe('upload');
  });

  it('收尾期间这一次作废了：交回 done（不存、也不再上传）', async () => {
    const r = await run();
    r.st.alive = false;
    expect(await r.settle()).toBe('done');
  });

  it('丢掉（signal 中止）：关连接、关音频上下文；之后的结局不认', async () => {
    const r = await run();
    r.a.ac.abort();
    expect(r.sess.close).toHaveBeenCalled();
    expect(fx.closed).toEqual([fx.ctx]);
    expect(await r.settle()).toBe('upload');
    expect(r.tap.level()).toBe(-1);
  });

  it('作废以后出的字不进面板', async () => {
    const r = await run();
    r.st.cur = null;
    r.sess.opts?.onText('晚到的字');
    expect(r.sets).toEqual([]);
  });
});
