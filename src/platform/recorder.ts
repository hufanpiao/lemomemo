// 录音：拿麦克风 → MediaRecorder 开录 → 停下交出一段只在内存里的录音。MediaRecorder、getUserMedia 按 A13 只准写在 platform：正式录音和开发用的录音探测页（app/dev/VoiceProbe.tsx）都用这里
// • start 事件到了才记起点、才告诉调用方“开始了”：调用方到这时才提示可以说话，早了句首会被切掉
// • 拿到流以后不管哪一步失败或取消，都先停录音器、关轨道、清计时器再返回（系统的录音指示不能一直亮）
// • 取消只有 signal 这一套，从调用到交出结果之前一直有效
// • 停录（stop()、录满）以后等 stop 事件最多 REC_STOP_WAIT_MS：iOS 偶尔不发，到点按 stop_timeout 收尾，录音器不会卡在“录音中”
// • 运行日志只记类型、字节数、毫秒、原因
import { audioType, bareMime } from '../../shared/schema/ai.ts';
import { errTag } from './err-tag.ts';
import { micResultOf, rememberMicResult } from './perm-mic.ts';
import { rlog } from './run-log-api.ts';

/** start() 之后等 start 事件最长多久，超过按开不起来算 */
export const REC_START_WAIT_MS = 3000;
/** 停录（调用方 stop()、录满 maxMs）之后等 stop 事件最长多久：iOS 偶尔不发，超过按 stop_timeout 收尾、关轨道（FA-3 整块评审第 2 条） */
export const REC_STOP_WAIT_MS = 3000;

export type MicFail = 'unsupported' | 'denied' | 'no_mic';
export type RecFail = MicFail | 'start_failed' | 'cancelled' | 'rec_error' | 'empty' | 'no_mime' | 'bad_mime' | 'too_large' | 'stop_timeout';

/** 交出来的录音一定交得出去：不是 0 字节、有类型且在 shared 的 AUDIO_TYPES 里、不超 maxBytes（这几条只在录音器判，上传层不重判） */
export interface RecClip {
  blob: Blob;
  /** 去掉参数、转成小写的类型（audio/mp4;codecs=mp4a.40.2 → audio/mp4），不会是空串；上传时直接当 Content-Type */
  mime: string;
  ms: number;
}

export type RecEnd = { ok: true; clip: RecClip; auto: boolean } | { ok: false; fail: RecFail };
export type RecStart = { ok: true; rec: ActiveRecorder } | { ok: false; fail: RecFail };

export interface ActiveRecorder {
  /** 从 start 事件起录了多久（毫秒）；结束以后停在最终时长 */
  elapsed(): number;
  /** 现在的音量 0～1（录音面板画波形用）；量不到（没有 Web Audio、接不上这条流、已经结束）返回 -1。
   *  第一次调时才接音量计（start 事件以后，不碍开录），结束时一起关掉 */
  level(): number;
  /** 停下并交出录音；重复调得到同一个结果 */
  stop(): Promise<RecEnd>;
}

export interface RecorderOptions {
  /** 最长录多久、最多多少字节：调用方传 record-logic 的 REC_MAX_MS（探测页传自己的 PROBE_MAX_MS）和 shared 的 AI_AUDIO_MAX_BYTES（platform 不引功能层，也不在这里引 zod 那一份） */
  maxMs: number;
  maxBytes: number;
  /** 必填，传 shared 的 AI_AUDIO_BITS_PER_SECOND：浏览器默认码率不受控（常见 128 kbps 上下，录满 60 秒会超字节上限） */
  bitsPerSecond: number;
  signal?: AbortSignal;
  /** 开录以后没人调 stop()、没取消，录音就结束了（录满 maxMs、轨道被系统收走、录音器出错）：通知一次，界面调 stop() 拿结局 */
  onAutoStop?: () => void;
  now?: () => number;
}

const perfNow = (): number => performance.now();

const closeTracks = (stream: MediaStream): void => {
  for (const t of stream.getTracks()) t.stop();
};

/** 音量计：同一条麦克风流接一个 AnalyserNode（只读，不改录音）。接不上返回 null */
interface Meter {
  read(): number;
  close(): void;
}

function openMeter(stream: MediaStream): Meter | null {
  const g = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor) return null;
  let ctx: AudioContext | null = null;
  try {
    ctx = new Ctor();
    const an = ctx.createAnalyser();
    an.fftSize = 256;
    ctx.createMediaStreamSource(stream).connect(an);
    // 不在手势里建的可能是 suspended：试着恢复，不行就一直量到 0（波形平着，不影响录音）
    void ctx.resume().catch(() => undefined);
    const buf = new Uint8Array(an.fftSize);
    const c = ctx;
    return {
      read() {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        return Math.min(1, Math.sqrt(sum / buf.length) * 4);
      },
      close() {
        void c.close().catch(() => undefined);
      },
    };
  } catch {
    void ctx?.close().catch(() => undefined);
    return null;
  }
}


export function recorderSupported(): boolean {
  return typeof MediaRecorder !== 'undefined' && typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function';
}

type MicOpen = { ok: true; stream: MediaStream } | { ok: false; fail: MicFail; type: string };

/** 要一次麦克风。允许、拒绝都记下（别的错不记）；开录和只申请权限共用这一段 */
async function openMic(): Promise<MicOpen> {
  if (!recorderSupported()) return { ok: false, fail: 'unsupported', type: '' };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    const denied = micResultOf(err) === 'denied';
    if (denied) rememberMicResult('denied');
    return { ok: false, fail: denied ? 'denied' : 'no_mic', type: errTag(err) };
  }
  rememberMicResult('granted');
  return { ok: true, stream };
}

/** 只申请麦克风权限，不录（说明卡上点“允许麦克风”的那一下里调）：拿到流马上关掉 */
export async function requestMic(now: () => number = perfNow): Promise<'granted' | MicFail> {
  const t0 = now();
  const mic = await openMic();
  if (mic.ok) closeTracks(mic.stream);
  rlog(`mic ask result=${mic.ok ? 'granted' : mic.fail} ms=${Math.round(now() - t0)}${mic.ok ? '' : mic.type}`);
  return mic.ok ? 'granted' : mic.fail;
}

/** 开录。等到 start 事件才兑现 ok；调用方拿到 ok 才算进了“录音中” */
export async function startRecorder(o: RecorderOptions): Promise<RecStart> {
  const now = o.now ?? perfNow;
  const t0 = now();
  const refuse = (fail: RecFail, more = ''): RecStart => {
    rlog(`rec fail reason=${fail}${more}`);
    return { ok: false, fail };
  };
  if (o.signal?.aborted) return refuse('cancelled');
  const mic = await openMic();
  if (!mic.ok) return refuse(mic.fail, mic.type);
  if (o.signal?.aborted) {
    closeTracks(mic.stream);
    return refuse('cancelled');
  }
  return record(mic.stream, o, now, Math.round(now() - t0));
}

function record(stream: MediaStream, o: RecorderOptions, now: () => number, gumMs: number): Promise<RecStart> {
  return new Promise<RecStart>((started) => {
    const parts: Blob[] = [];
    let rec: MediaRecorder | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let calledAt = 0;
    /** start 事件的时刻；null = 还在等它 */
    let startAt: number | null = null;
    let endAt: number | null = null;
    /** 调用方调过 stop() */
    let asked = false;
    let end: RecEnd | null = null;
    /** 音量计：undefined = 还没接过；null = 接不上 */
    let meter: Meter | null | undefined;
    let giveEnd: (r: RecEnd) => void = () => undefined;
    const ended = new Promise<RecEnd>((r) => (giveEnd = r));

    const halt = (): void => {
      try {
        if (rec && rec.state !== 'inactive') rec.stop();
      } catch {
        // 已经停了
      }
    };
    /** 定结局，只定一次：收拾干净，再告诉等着的人 */
    const finish = (r: RecEnd, log: string): void => {
      if (end) return;
      end = r;
      endAt ??= now();
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      halt();
      meter?.close();
      meter = null;
      closeTracks(stream);
      parts.length = 0;
      rlog(log);
      if (startAt === null && !r.ok) started(r);
      giveEnd(r);
      // 录音结束只从这里告诉界面：不管为什么结束，调用方没要停、也没取消，就通知
      if (startAt !== null && !asked && !(!r.ok && r.fail === 'cancelled')) o.onAutoStop?.();
    };
    const fail = (f: RecFail, more = '', reason: string = f): void => finish({ ok: false, fail: f }, `rec fail reason=${reason}${more}`);
    const onAbort = (): void => fail('cancelled');
    /** 停录并等 stop 事件，到点还没来就按 stop_timeout 收尾（只起一次） */
    let stopping = false;
    const stopNow = (): void => {
      halt();
      if (stopping || end) return;
      stopping = true;
      clearTimeout(timer);
      timer = setTimeout(() => fail('stop_timeout'), REC_STOP_WAIT_MS);
    };

    const onStart = (): void => {
      if (end || startAt !== null || !rec) return;
      startAt = now();
      clearTimeout(timer);
      timer = setTimeout(stopNow, o.maxMs);
      rlog(`rec start mime=${bareMime(rec.mimeType) || '?'} gum_ms=${gumMs} start_ms=${Math.round(startAt - calledAt)}`);
      started({
        ok: true,
        rec: {
          elapsed: () => (startAt === null ? 0 : Math.round((endAt ?? now()) - startAt)),
          level() {
            if (end) return -1;
            if (meter === undefined) {
              meter = openMeter(stream);
              rlog(`rec meter ${meter ? 'on' : 'off'}`);
            }
            return meter ? meter.read() : -1;
          },
          stop() {
            asked = true;
            stopNow();
            return ended;
          },
        },
      });
    };
    const onStop = (): void => {
      if (end) return;
      if (startAt === null) return fail('start_failed');
      endAt = now();
      const auto = !asked;
      const ms = Math.round(endAt - startAt);
      const mime = bareMime(rec?.mimeType || parts[0]?.type || '');
      const blob = new Blob(parts, { type: mime });
      const size = ` bytes=${blob.size} ms=${ms}`;
      if (blob.size === 0) fail('empty', size);
      else if (blob.size > o.maxBytes) fail('too_large', size);
      else if (mime === '') fail('no_mime', size);   // 录音器和各片都没标类型：发出去服务器只会回 415，重试也一样
      else if (audioType(mime) === null) fail('bad_mime', size);   // 标了类型但不在 shared 的 AUDIO_TYPES 里：服务器同样回 415
      else finish({ ok: true, clip: { blob, mime, ms }, auto }, `rec end${size} auto=${auto ? 1 : 0}`);
    };

    try {
      const r = new MediaRecorder(stream, { audioBitsPerSecond: o.bitsPerSecond });
      rec = r;
      r.addEventListener('start', onStart);
      r.addEventListener('dataavailable', (ev) => {
        if (!end && ev.data.size > 0) parts.push(ev.data);
      });
      r.addEventListener('error', (ev) => fail(startAt === null ? 'start_failed' : 'rec_error', errTag((ev as ErrorEvent).error)));
      r.addEventListener('stop', onStop);
      o.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => fail('start_failed', '', 'start_timeout'), REC_START_WAIT_MS);
      calledAt = now();
      r.start();
    } catch (err) {
      fail('start_failed', errTag(err));
    }
  });
}
