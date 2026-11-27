// Gemini Live 实时转写的一次会话（platform/live-transcribe.ts）：假音频上下文、假 worklet 端口、假 WebSocket
// 覆盖：连上之前攒的音一次补发、边说边出字、松手发完结束当场交出已出的字（不等定稿，负责人 11-24 选“松手马上用已出的字存”）、
// 之后连接只收不发再留 AFTER_END_MS 记 live after_end、中途断线、松手时还没连上不等、拿不到令牌、不记说的字
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RL_SLOT } from '../run-log-api.ts';
import { AFTER_END_MS, LIVE_BACKLOG_MS, LIVE_CONNECT_MS, openLive, type LiveOpts, type LiveSession } from '../live-transcribe.ts';

vi.mock('../live-worklet.ts?worker&url', () => ({ default: '/assets/live-worklet.js' }));

class FakePort {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  /** 收到 flush 就回 flushed（假的 worklet） */
  answerFlush = true;
  postMessage(m: unknown): void {
    this.posted.push(m);
    if (m === 'flush' && this.answerFlush) queueMicrotask(() => this.emit('flushed'));
  }
  close(): void {}
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent);
  }
}
class FakeNode {
  static made: FakeNode[] = [];
  port = new FakePort();
  connect = vi.fn();
  disconnect = vi.fn();
  name: string;
  constructor(_ctx: unknown, name: string) {
    this.name = name;
    FakeNode.made.push(this);
  }
}
const node0 = (): FakeNode => {
  const n = FakeNode.made[0];
  if (!n) throw new Error('还没建 worklet 节点');
  return n;
};

class FakeWs {
  static made: FakeWs[] = [];
  readyState = 0;
  binaryType = '';
  sent: string[] = [];
  closed: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWs.made.push(this);
  }
  send(s: string): void {
    this.sent.push(s);
  }
  close(code: number): void {
    this.closed = code;
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  say(v: unknown): void {
    this.onmessage?.({ data: JSON.stringify(v) } as MessageEvent);
  }
  drop(code: number): void {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
  /** 发出去的消息里音频块、结束各几条 */
  audio(): number {
    return this.sent.filter((s) => s.includes('"audio"')).length;
  }
  ended(): boolean {
    return this.sent.some((s) => s.includes('audioStreamEnd'));
  }
}
const ws0 = (): FakeWs => {
  const w = FakeWs.made[0];
  if (!w) throw new Error('还没连');
  return w;
};

const fakeCtx = () =>
  ({
    state: 'running',
    sampleRate: 48_000,
    resume: vi.fn(async () => undefined),
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createMediaStreamSource: vi.fn(() => ({ connect: vi.fn(), disconnect: vi.fn() })),
    createGain: vi.fn(() => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() })),
    destination: {},
  }) as unknown as AudioContext;

const TOKEN = { token: 'auth_tokens/abc', api: 'v1beta', setup: { model: 'models/gemini-3.5-transcribe-live' } };
/** 100 ms 的 48 kHz 样本（降到 16 kHz 是 1600 个） */
const block = (v = 0.2): Float32Array => new Float32Array(4800).fill(v);

let lines: string[] = [];
let texts: string[] = [];
let sess: LiveSession;

async function open(over: Partial<LiveOpts> = {}): Promise<LiveSession> {
  sess = await openLive({
    ctx: fakeCtx(),
    stream: {} as MediaStream,
    lang: 'zh-CN',
    onText: (t) => texts.push(t),
    ws: (u) => new FakeWs(u) as unknown as WebSocket,
    ...over,
  });
  return sess;
}
/** 连上（open + setupComplete） */
function ready(): FakeWs {
  sess.connect(TOKEN);
  const w = ws0();
  w.open();
  w.say({ setupComplete: {} });
  return w;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('AudioWorkletNode', FakeNode);
  FakeNode.made = [];
  FakeWs.made = [];
  lines = [];
  texts = [];
  (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => lines.push(l) };
});
afterEach(() => {
  sess.close();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as Record<string, unknown>)[RL_SLOT];
});

describe('live-transcribe 一次会话', () => {
  it('接上 worklet 和静音输出；连上之前攒的音，setupComplete 以后一次补发', async () => {
    await open();
    expect(node0().name).toBe('lemo-pcm-tap');
    node0().port.emit(block());
    node0().port.emit(block());
    sess.connect(TOKEN);
    const w = ws0();
    expect(w.url).toContain('BidiGenerateContentConstrained?access_token=auth_tokens%2Fabc');
    w.open();
    expect(JSON.parse(w.sent[0] ?? '{}')).toEqual({ setup: TOKEN.setup });
    expect(w.audio(), '没连上之前不发音').toBe(0);
    w.say({ setupComplete: {} });
    expect(w.audio(), '攒的两块补发').toBe(2);
    node0().port.emit(block());
    expect(w.audio(), '之后边录边发').toBe(3);
    expect(sess.level()).toBeCloseTo(0.8, 5);
  });

  it('边说边出字：正在说的 + 定稿的拼成全文交给 onText；松手发完结束不等定稿，当场交出定稿 + 正在说的', async () => {
    await open();
    const w = ready();
    node0().port.emit(block());
    w.say({ serverContent: { interimInputTranscription: { text: '买牛' } } });
    w.say({ serverContent: { interimInputTranscription: { text: '买牛奶' } } });
    w.say({ serverContent: { inputTranscription: { text: '买牛奶' } } });
    w.say({ serverContent: { interimInputTranscription: { text: '和面包' } } });
    expect(texts).toEqual(['买牛', '买牛奶', '买牛奶', '买牛奶和面包']);
    const p = sess.finish();
    let done = false;
    void p.then(() => (done = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(w.ended(), '松手发 audioStreamEnd').toBe(true);
    expect(done, '发完结束当场交出，不等定稿、不等一轮完').toBe(true);
    const e = await p;
    expect(e.ok && e.text, '正在说的半段也算').toBe('买牛奶和面包');
    expect(e.stats.len).toBe(6);
    expect(e.stats.connMs).not.toBeNull();
    expect(e.stats.firstMs).not.toBeNull();
    expect(e.stats.capMs).toBe(100);
    expect(e.stats.sentMs).toBe(100);
    expect(lines.join('\n'), '日志不记说的字、不记令牌').not.toMatch(/牛奶|面包|abc/);
    expect(lines.some((l) => l.startsWith('live text1 ms='))).toBe(true);
  });

  it(`交出字以后连接只收不发再留 ${AFTER_END_MS} 毫秒：之后来的定稿、中间结果、一轮完了只计数（不再出字），到点记 live after_end 再关`, async () => {
    await open();
    const w = ready();
    w.say({ serverContent: { interimInputTranscription: { text: '买' } } });
    const p = sess.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toMatchObject({ ok: true, text: '买' });
    const sent = w.sent.length;
    // 调用方收拾（close）：节点断开，连接照样留着
    sess.close();
    expect(node0().disconnect).toHaveBeenCalled();
    expect(w.closed, '诊断那一段没到头，连接还开着').toBeNull();
    w.say({ serverContent: { interimInputTranscription: { text: '买菜' } } });
    w.say({ serverContent: { inputTranscription: { text: '买菜' }, turnComplete: true } });
    expect(texts.at(-1), '交出去以后不再出字').toBe('买');
    await vi.advanceTimersByTimeAsync(AFTER_END_MS - 10);
    expect(w.closed).toBeNull();
    await vi.advanceTimersByTimeAsync(20);
    expect(w.closed).toBe(1000);
    expect(w.sent.length, '只收不发').toBe(sent);
    expect(lines).toContain(`live after_end final=1 interim=1 turn=1 close=-1 ms=${AFTER_END_MS}`);
    expect(lines.join('\n')).not.toMatch(/买|菜/);
  });

  it('交出字以后服务器关了连接：当场记 live after_end（带关闭码），不再等到点', async () => {
    await open();
    const w = ready();
    w.say({ serverContent: { inputTranscription: { text: '明天开会' } } });
    const p = sess.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect((await p).text).toBe('明天开会');
    await vi.advanceTimersByTimeAsync(500);
    w.drop(1006);
    expect(lines).toContain('live after_end final=0 interim=0 turn=0 close=1006 ms=500');
    await vi.advanceTimersByTimeAsync(AFTER_END_MS);
    expect(lines.filter((l) => l.startsWith('live after_end')), '只记一行').toHaveLength(1);
  });

  it('中途断线：不再发，音量照量；松手回 close_码，已出的字照样带上', async () => {
    await open();
    const w = ready();
    w.say({ serverContent: { inputTranscription: { text: '买牛' } } });
    w.drop(1011);
    node0().port.emit(block(0.1));
    expect(w.audio()).toBe(0);
    expect(sess.level()).toBeCloseTo(0.4, 5);
    expect(await sess.finish()).toMatchObject({ ok: false, why: 'close_1011', text: '买牛' });
    expect(lines.some((l) => l.startsWith('live drop why=close_1011'))).toBe(true);
  });

  it('连不上：LIVE_CONNECT_MS 到了算 connect_timeout', async () => {
    await open();
    sess.connect(TOKEN);
    ws0().open();
    await vi.advanceTimersByTimeAsync(LIVE_CONNECT_MS + 1);
    expect(ws0().closed).toBe(1000);
    expect(await sess.finish()).toMatchObject({ ok: false, why: 'connect_timeout' });
  });

  it('松手时还在连：不再等（没连上就没出过字），要回半块以后当场回 not_ready、关掉连接', async () => {
    await open();
    node0().port.emit(block());
    sess.connect(TOKEN);
    const w = ws0();
    w.open();
    const p = sess.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toMatchObject({ ok: false, why: 'not_ready', text: '' });
    expect(w.ended()).toBe(false);
    expect(w.closed).toBe(1000);
  });

  it('松手时令牌一直没到：当场回 not_ready，不连', async () => {
    await open();
    const p = sess.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toMatchObject({ ok: false, why: 'not_ready' });
    expect(FakeWs.made).toHaveLength(0);
  });

  it('拿不到令牌（fail）、令牌版本不认识：不连，松手回原因', async () => {
    await open();
    sess.fail('token_quota_out');
    expect(await sess.finish()).toMatchObject({ ok: false, why: 'token_quota_out' });
    sess.close();
    FakeNode.made = [];
    await open();
    sess.connect({ ...TOKEN, api: 'v9' });
    expect(FakeWs.made).toHaveLength(0);
    expect(await sess.finish()).toMatchObject({ ok: false, why: 'bad_token' });
  });

  it('worklet 没回 flushed：最多等一会儿照样往下走（之后照样冻结）', async () => {
    await open();
    const w = ready();
    node0().port.answerFlush = false;
    w.say({ serverContent: { inputTranscription: { text: '买' } } });
    const p = sess.finish();
    await vi.advanceTimersByTimeAsync(400);
    expect(w.ended()).toBe(true);
    node0().port.emit(block());
    expect(w.audio(), '冻结以后的块不发').toBe(0);
    expect(await p).toMatchObject({ ok: true, text: '买' });
  });

  it('评审第 3 条：松手要回半块以后采音冻结，之后来的块不计 cap、不发；第一块音到达的时刻记在 audioAt', async () => {
    let t = 1000;
    await open({ now: () => t });
    t = 1250;
    node0().port.emit(block());
    const w = ready();
    node0().port.emit(block());
    const p = sess.finish();
    // 半块（flush 的回应之前 worklet 交来的）照常算
    node0().port.emit(block());
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i++) node0().port.emit(block());
    expect(w.audio(), '冻结以后不再发').toBe(3);
    const e = await p;
    expect([e.stats.capMs, e.stats.sentMs, e.stats.audioAt]).toEqual([300, 300, 1250]);
    expect(sess.level(), '冻结以后音量照量').toBeCloseTo(0.8, 5);
  });

  it('一个字都没出：发完结束照样当场交出空串（调用方退回占位加上传，不在这里等）', async () => {
    await open();
    const w = ready();
    node0().port.emit(block());
    const p = sess.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(await p).toMatchObject({ ok: true, text: '' });
    expect(w.ended()).toBe(true);
  });

  it(`评审第 8 条：松手时还没发出去的超过 ${LIVE_BACKLOG_MS} 毫秒：不发结束，回 backlog，已出的字照样带上`, async () => {
    await open();
    const w = ready();
    w.say({ serverContent: { inputTranscription: { text: '买' } } });
    // 16 kHz、每样本约 8/3 字节：2.5 秒约 106667 字节
    (w as unknown as { bufferedAmount: number }).bufferedAmount = 106_667;
    const e = await (async () => {
      const p = sess.finish();
      await vi.advanceTimersByTimeAsync(0);
      return p;
    })();
    expect(e).toMatchObject({ ok: false, why: 'backlog', text: '买' });
    expect(e.stats.backlogMs).toBe(2500);
    expect(w.ended()).toBe(false);
  });

  it('评审第 7 条：上下文不是 running 就 resume，每次变化记日志并再试着恢复', async () => {
    const ctx = fakeCtx() as unknown as { state: string; resume: ReturnType<typeof vi.fn>; onstatechange: (() => void) | null };
    ctx.state = 'suspended';
    await open({ ctx: ctx as unknown as AudioContext });
    expect(ctx.resume).toHaveBeenCalledTimes(1);
    ctx.state = 'interrupted';
    ctx.onstatechange?.();
    expect(ctx.resume).toHaveBeenCalledTimes(2);
    expect(lines).toContain('live ctx state=interrupted ms=0');
    sess.close();
    expect(ctx.onstatechange).toBeNull();
  });

  it('评审第 19 条：中间结果、定稿、modelTurn 各几条记在 stats', async () => {
    await open();
    const w = ready();
    w.say({ serverContent: { interimInputTranscription: { text: '买' } } });
    w.say({ serverContent: { interimInputTranscription: { text: '买菜' } } });
    w.say({ serverContent: { modelTurn: { parts: [{ text: 'x' }] } } });
    w.say({ serverContent: { inputTranscription: { text: '买菜' } } });
    const p = sess.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect((await p).stats).toMatchObject({ nInterim: 2, nFinal: 1, nModel: 1 });
  });

  it('二进制帧（ArrayBuffer）也能解', async () => {
    await open();
    const w = ready();
    w.onmessage?.({ data: new TextEncoder().encode('{"serverContent":{"inputTranscription":{"text":"买"}}}').buffer } as MessageEvent);
    expect(texts).toEqual(['买']);
  });

  it('close（还在要回半块时）：等着的 finish 回 closed，节点断开、连接当场关掉，不记 after_end', async () => {
    await open();
    const w = ready();
    node0().port.answerFlush = false;
    const p = sess.finish();
    await vi.advanceTimersByTimeAsync(0);
    sess.close();
    expect(await p).toMatchObject({ ok: false, why: 'closed' });
    expect(node0().disconnect).toHaveBeenCalled();
    expect(w.closed).toBe(1000);
    expect(w.ended()).toBe(false);
    await vi.advanceTimersByTimeAsync(AFTER_END_MS + 10);
    expect(lines.some((l) => l.startsWith('live after_end'))).toBe(false);
  });
});
