// Gemini Live 实时转写的一次会话：按住“＋”时由 features/plus/data/voice-gemini.ts 懒加载（不进首屏，按下时预取）。
// • 麦克风只开一路：用录音器（platform/recorder.ts）已经拿到的那条流，另接一个 AudioWorklet 采原始样本（录音器照旧录，失败时整段上传兜底）
// • 音频上下文由调用方在按住手势里建好传进来（platform/live-audio.ts 的 openAudioCtx），这里只接节点；关上下文也归调用方。
//   上下文不是 running（suspended、iOS 的 interrupted）就 resume，每次变化记日志
// • 采到的音先攒着，连上（setupComplete）以后一次补发，之后边录边发，约 100 ms 一块；记下第一块音到达的时刻（audioAt），
//   调用方拿它和录音器开录的时刻比，只记进日志（head_ms）：开头缺一截照样用这次的字，后台用完整录音交 ai-voice 补上
// • 中间结果、定稿的字拼成全文实时交给 onText（已定稿的段 + 正在说的这一段，shared/logic/join-said.ts）
// • 松手 finish()（调用方在松手那一刻就调，和录音器停录并行）：先把 worklet 里没攒满的半块要回来，要回来（或等满 FLUSH_WAIT_MS）
//   那一刻起采音冻结（采到、发出去的长度只算松手之前的）；积压超过 LIVE_BACKLOG_MS 不发结束；
//   发 audioStreamEnd 以后不再等定稿，当场交出屏幕上已出的字（定稿 + 正在说的）：
//   Gemini 不保证一定给定稿（inputTranscription），等定稿可能干等。最后几个字由调用方后台用录音交 ai-voice 补
// • 交出字以后连接再留 AFTER_END_MS 只收不发，查服务器到底给不给定稿：到点或连接被关记一行 live after_end，再关
// • 不管成没成，finish 都带上已出的字（ok: false 时可能是半截，调用方照样先存、后台用录音补）
// • 断线（连不上、超时、中途被关）只把会话标成失败、不再发，音量照样量（声波照旧跟着真实麦克风电平动）
// • 运行日志只记毫秒、字数、条数、关闭码、原因；不记说的字，不记令牌和连接地址
// eslint-disable-next-line boundaries/no-unknown-dependencies -- Vite 的 ?worker&url 后缀（单独打包、只取地址），边界插件认不出带后缀的路径；指向的就是同目录 platform/live-worklet.ts
import workletUrl from './live-worklet.ts?worker&url';
import { joinSaid } from '../../shared/logic/join-said.ts';
import { errTag } from './err-tag.ts';
import { END_MSG, LIVE_RATE, audioMsg, blockLevel, createDown16k, interimTail, liveUrl, parseServer, setupMsg } from './live-proto.ts';
import { rlog } from './run-log-api.ts';

/** 开连接到 setupComplete 最多等多久 */
export const LIVE_CONNECT_MS = 5000;
/** 发完 audioStreamEnd、交出字以后，连接再留多久只收不发（诊断：服务器给不给定稿） */
export const AFTER_END_MS = 3000;
/** 松手时还没发出去的音超过这么多毫秒：不发结束了（网太慢，后面的字靠录音补） */
export const LIVE_BACKLOG_MS = 2000;
/** 连上之前最多攒多少秒（按住最长 60 秒） */
const QUEUE_MAX_S = 70;
/** 要回 worklet 里半块的最多等多久 */
const FLUSH_WAIT_MS = 300;
/** 发出去的消息里一个样本约占几字节：16 位 2 字节，base64 放大 4/3（JSON 外壳忽略） */
const WIRE_BYTES_PER_SAMPLE = (2 * 4) / 3;
/** worklet 的处理器名字（live-worklet.ts 里注册的同一个串） */
const TAP = 'lemo-pcm-tap';

export interface LiveToken {
  token: string;
  api: string;
  /** 服务器锁进令牌的 setup（ai-live-token 回的），原样发 */
  setup: Record<string, unknown>;
}
/**
 * 日志、兜底判断用的几个数：conn 连上、first 第一次出字（从 openLive 算，毫秒）；cap 采到、sent 发出去的音频长度（毫秒，都只算松手之前的）；
 * audioAt 第一块音到达的时刻（o.now 的时钟，没到过 null）；backlog 松手时还没发出去的毫秒；n* 收到的中间结果、定稿、modelTurn 各几条
 */
export interface LiveStats {
  connMs: number | null;
  firstMs: number | null;
  len: number;
  capMs: number;
  sentMs: number;
  audioAt: number | null;
  backlogMs: number;
  nInterim: number;
  nFinal: number;
  nModel: number;
}
/** 松手的结局：ok 发出了结束；没发出（没连上、断线、积压太多）带原因。text 都是这一刻屏幕上已出的字（可能是空串） */
export type LiveEnd = ({ ok: true } | { ok: false; why: string }) & { text: string; stats: LiveStats };

export interface LiveSession {
  /** 拿到令牌：连上 Gemini */
  connect(t: LiveToken): void;
  /** 拿不到令牌：这次不连了（音量照量，松手退回上传） */
  fail(why: string): void;
  /** 现在的音量 0～1（真实麦克风电平） */
  level(): number;
  /** 松手：冻结采音、发结束、交出已出的字（不等定稿；调几次都是同一个结果） */
  finish(): Promise<LiveEnd>;
  /** 不要了：断开节点、关连接（不关音频上下文）；已经发了结束的，连接留到 AFTER_END_MS 记完诊断再关 */
  close(): void;
}

export interface LiveOpts {
  ctx: AudioContext;
  stream: MediaStream;
  /** 界面语言（拼字时韩文隔空格） */
  lang: string;
  onText(text: string): void;
  now?: () => number;
  /** 测试换假的 */
  ws?: (url: string) => WebSocket;
}

/** after：发了结束、字已交出，连接只收不发（诊断） */
type State = 'wait' | 'connecting' | 'ready' | 'after' | 'done' | 'dead';

/** 接上麦克风、开始采音（还不连网）；worklet 加载不了、接不上流就抛错，调用方当作这次实时转写用不了 */
export async function openLive(o: LiveOpts): Promise<LiveSession> {
  const now = o.now ?? (() => performance.now());
  const t0 = now();
  const ms = (): number => Math.round(now() - t0);
  const { ctx } = o;
  let state: State = 'wait';
  const wake = (): void => {
    if (ctx.state !== 'running' && ctx.state !== 'closed') void ctx.resume().catch((e: unknown) => rlog(`live ctx resume_fail${errTag(e)}`));
  };
  ctx.onstatechange = () => {
    rlog(`live ctx state=${ctx.state} ms=${ms()}`);
    if (state !== 'done') wake();
  };
  wake();
  await ctx.audioWorklet.addModule(workletUrl);
  const src = ctx.createMediaStreamSource(o.stream);
  const node = new AudioWorkletNode(ctx, TAP, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(node);
  node.connect(mute);
  mute.connect(ctx.destination);
  rlog(`live audio rate=${ctx.sampleRate} ctx=${ctx.state} ms=${ms()}`);

  const down = createDown16k(ctx.sampleRate);
  let why = '';
  let ws: WebSocket | null = null;
  let queue: Int16Array[] = [];
  let queued = 0;
  let cap = 0;
  let sent = 0;
  let lvl = 0;
  let audioAt: number | null = null;
  /** 松手要回半块以后：采音冻结 */
  let frozen = false;
  let backlogMs = 0;
  let finals = '';
  let interim = '';
  let nInterim = 0;
  let nFinal = 0;
  let nModel = 0;
  /** 发了结束以后（诊断）：那一刻、之后收到的定稿 / 中间结果 / 一轮完了各几条 */
  let endAt = 0;
  const after = { final: 0, interim: 0, turn: 0 };
  let connMs: number | null = null;
  let firstMs: number | null = null;
  let connTimer: ReturnType<typeof setTimeout> | undefined;
  let afterTimer: ReturnType<typeof setTimeout> | undefined;
  let onFlushed: (() => void) | null = null;
  let finP: Promise<LiveEnd> | null = null;

  const pending = (): string => interimTail(finals, interim);
  const text = (): string => joinSaid(o.lang, finals, pending());
  const stats = (): LiveStats => ({
    connMs, firstMs, len: [...text()].length, capMs: Math.round((cap * 1000) / LIVE_RATE), sentMs: Math.round((sent * 1000) / LIVE_RATE),
    audioAt, backlogMs, nInterim, nFinal, nModel,
  });
  /** 还没发出去的有多少毫秒：队列里的 + WebSocket 缓冲里的 */
  const backlog = (): number => {
    const inQueue = queue.reduce((s, p) => s + p.length, 0);
    const buffered = typeof ws?.bufferedAmount === 'number' ? ws.bufferedAmount / WIRE_BYTES_PER_SAMPLE : 0;
    return Math.round(((inQueue + buffered) * 1000) / LIVE_RATE);
  };

  const send = (pcm: Int16Array): void => {
    // 1 = OPEN
    if (ws?.readyState !== 1) return;
    ws.send(audioMsg(pcm));
    sent += pcm.length;
  };
  const shut = (): void => {
    clearTimeout(connTimer);
    clearTimeout(afterTimer);
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close(1000);
      } catch {
        // 已经关了
      }
      ws = null;
    }
    queue = [];
  };
  const dead = (w: string): void => {
    if (state === 'done' || state === 'dead') return;
    rlog(`live drop why=${w} state=${state} ms=${ms()}`);
    state = 'dead';
    why = w;
    shut();
  };
  const end = (e: { ok: true } | { ok: false; why: string }): LiveEnd => ({ ...e, text: text(), stats: stats() });
  /** 发了结束以后留的那一段到头（到点，或连接被关 code）：记一行诊断、关掉 */
  const afterDone = (code: number): void => {
    if (state !== 'after') return;
    rlog(`live after_end final=${after.final} interim=${after.interim} turn=${after.turn} close=${code} ms=${Math.round(now() - endAt)}`);
    state = 'done';
    shut();
  };
  const mark = (t: string): void => {
    if (firstMs === null && t.trim() !== '') {
      firstMs = ms();
      rlog(`live text1 ms=${firstMs}`);
    }
  };
  const onRaw = (raw: string): void => {
    if (state === 'done' || state === 'dead') return;
    for (const m of parseServer(raw)) {
      // 字已经交出去了：只数服务器之后还给了什么（不再拼字、不再出字）
      if (state === 'after') {
        if (m.kind === 'final' || m.kind === 'interim' || m.kind === 'turn') after[m.kind] += 1;
        continue;
      }
      if (m.kind === 'ready' && state === 'connecting') {
        clearTimeout(connTimer);
        state = 'ready';
        connMs = ms();
        rlog(`live ready ms=${connMs} queued_ms=${Math.round((queued * 1000) / LIVE_RATE)}`);
        for (const p of queue) send(p);
        queue = [];
      } else if (m.kind === 'interim') {
        nInterim += 1;
        interim = m.text;
        mark(m.text);
        o.onText(text());
      } else if (m.kind === 'final') {
        nFinal += 1;
        finals = joinSaid(o.lang, finals, m.text);
        interim = '';
        mark(m.text);
        o.onText(text());
      } else if (m.kind === 'model') nModel += 1;
      else if (m.kind === 'away') rlog(`live goaway ms=${ms()}`);
    }
  };

  node.port.onmessage = (ev: MessageEvent) => {
    if (ev.data === 'flushed') {
      frozen = true;
      return onFlushed?.();
    }
    if (!(ev.data instanceof Float32Array) || state === 'done') return;
    lvl = blockLevel(ev.data);
    if (frozen) return;
    audioAt ??= now();
    const pcm = down(ev.data);
    if (pcm.length === 0) return;
    cap += pcm.length;
    if (state === 'ready') send(pcm);
    else if (state !== 'dead' && queued < LIVE_RATE * QUEUE_MAX_S) {
      queue.push(pcm);
      queued += pcm.length;
    }
  };

  const wait = (ms0: number, arm: (go: () => void) => void): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(resolve, ms0);
      arm(() => {
        clearTimeout(t);
        resolve();
      });
    });

  return {
    connect(t) {
      if (state !== 'wait') return;
      const url = liveUrl(t.api, t.token);
      if (url === null) return dead('bad_token');
      state = 'connecting';
      try {
        ws = (o.ws ?? ((u: string) => new WebSocket(u)))(url);
      } catch (e) {
        rlog(`live ws throw${errTag(e)}`);
        return dead('ws_throw');
      }
      ws.binaryType = 'arraybuffer';
      connTimer = setTimeout(() => dead('connect_timeout'), LIVE_CONNECT_MS);
      ws.onopen = () => {
        rlog(`live ws open ms=${ms()}`);
        ws?.send(setupMsg(t.setup));
      };
      ws.onmessage = (ev: MessageEvent) => {
        const d: unknown = ev.data;
        if (typeof d === 'string') onRaw(d);
        // 按类型标签认（跨领域的 ArrayBuffer 用 instanceof 认不出）
        else if (Object.prototype.toString.call(d) === '[object ArrayBuffer]') onRaw(new TextDecoder().decode(d as ArrayBuffer));
        else if (d instanceof Blob) void d.text().then(onRaw, () => undefined);
      };
      ws.onerror = () => rlog(`live ws error state=${state} ms=${ms()}`);
      ws.onclose = (ev: CloseEvent) => {
        rlog(`live close code=${ev.code} state=${state} ms=${ms()}`);
        // 发了结束以后服务器关了：诊断那一段到头
        if (state === 'after') return afterDone(ev.code);
        dead(`close_${ev.code}`);
      };
    },
    fail(w) {
      if (state === 'wait') dead(w);
    },
    level: () => lvl,
    finish() {
      finP ??= (async (): Promise<LiveEnd> => {
        if (state === 'dead' || state === 'done') {
          frozen = true;
          return end({ ok: false, why: why || 'closed' });
        }
        // worklet 里没攒满的半块要回来（照常发出去或攒进队列）；要回来（或等满）那一刻起冻结
        await wait(FLUSH_WAIT_MS, (go) => {
          onFlushed = go;
          node.port.postMessage('flush');
        });
        onFlushed = null;
        frozen = true;
        // 读现在的状态（await 期间连接那边会改它）；没连上不再等（没连上就没出过字，等到连上也来不及出字）
        const st = (): State => state;
        if (st() !== 'ready') {
          const w = st() === 'dead' ? why : st() === 'done' ? 'closed' : 'not_ready';
          dead(w);
          return end({ ok: false, why: w });
        }
        backlogMs = backlog();
        if (backlogMs > LIVE_BACKLOG_MS) {
          const out = end({ ok: false, why: 'backlog' });
          dead('backlog');
          return out;
        }
        ws?.send(END_MSG);
        // 不等定稿（见文件头）：这一刻的字就是交出去的；连接再留 AFTER_END_MS 只收不发，记服务器之后给了什么
        const out = end({ ok: true });
        state = 'after';
        endAt = now();
        afterTimer = setTimeout(() => afterDone(-1), AFTER_END_MS);
        return out;
      })();
      return finP;
    },
    close() {
      // 发了结束、诊断那一段还没到头：连接留着到点再关（节点照样断开）
      if (state !== 'done' && state !== 'after') {
        shut();
        state = 'done';
      }
      ctx.onstatechange = null;
      onFlushed?.();
      node.port.onmessage = null;
      try {
        src.disconnect();
        node.disconnect();
        mute.disconnect();
        node.port.close();
      } catch {
        // 已经断开了
      }
    },
  };
}
