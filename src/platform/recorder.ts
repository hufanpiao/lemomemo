// 录音：拿麦克风 → MediaRecorder 开录 → 停下交出一段只在内存里的录音。MediaRecorder、getUserMedia 只在这里用（A13）
// • start 事件到了才记起点、才告诉调用方“开始了”：调用方到这时才提示可以说话，早了句首会被切掉
// • 拿到流以后不管哪一步失败或取消，都先停录音器、关轨道、清计时器再返回（系统的录音指示不能一直亮）
// • 取消只有 signal 这一套，从调用到交出结果之前一直有效
// • 运行日志只记类型、字节数、毫秒、原因
import { micResultOf, rememberMicResult } from './perm-mic.ts';
import { errTag, rlog } from './run-log-api.ts';

/** start() 之后等 start 事件最长多久，超过按开不起来算 */
export const REC_START_WAIT_MS = 3000;

export type MicFail = 'unsupported' | 'denied' | 'no_mic';
export type RecFail = MicFail | 'start_failed' | 'cancelled' | 'rec_error' | 'empty' | 'too_large';

export interface RecClip {
  blob: Blob;
  /** 去掉参数、转成小写的类型（audio/mp4;codecs=mp4a.40.2 → audio/mp4），上传时直接当 Content-Type */
  mime: string;
  ms: number;
}

export type RecEnd = { ok: true; clip: RecClip; auto: boolean } | { ok: false; fail: RecFail };
export type RecStart = { ok: true; rec: ActiveRecorder } | { ok: false; fail: RecFail };

export interface ActiveRecorder {
  /** 从 start 事件起录了多久（毫秒）；结束以后停在最终时长 */
  elapsed(): number;
  /** 停下并交出录音；重复调得到同一个结果 */
  stop(): Promise<RecEnd>;
}

export interface RecorderOptions {
  /** 最长录多久、最多多少字节：调用方传功能层的那两个常量（platform 不引功能层） */
  maxMs: number;
  maxBytes: number;
  /** 给了才带 audioBitsPerSecond；不给就按浏览器默认码率录 */
  bitsPerSecond?: number;
  signal?: AbortSignal;
  /** 没人调 stop() 录音就停了（录满 maxMs、轨道被系统收走）：界面照松手处理 */
  onAutoStop?: () => void;
  now?: () => number;
}

const perfNow = (): number => performance.now();

const closeTracks = (stream: MediaStream): void => {
  for (const t of stream.getTracks()) t.stop();
};

const bareMime = (m: string): string => m.split(';')[0]?.trim().toLowerCase() ?? '';

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
      closeTracks(stream);
      parts.length = 0;
      rlog(log);
      if (startAt === null && !r.ok) started(r);
      giveEnd(r);
    };
    const fail = (f: RecFail, more = '', reason: string = f): void => finish({ ok: false, fail: f }, `rec fail reason=${reason}${more}`);
    const onAbort = (): void => fail('cancelled');

    const onStart = (): void => {
      if (end || startAt !== null || !rec) return;
      startAt = now();
      clearTimeout(timer);
      timer = setTimeout(halt, o.maxMs);
      rlog(`rec start mime=${bareMime(rec.mimeType) || '?'} gum_ms=${gumMs} start_ms=${Math.round(startAt - calledAt)}`);
      started({
        ok: true,
        rec: {
          elapsed: () => (startAt === null ? 0 : Math.round((endAt ?? now()) - startAt)),
          stop() {
            asked = true;
            halt();
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
      else finish({ ok: true, clip: { blob, mime, ms }, auto }, `rec end${size} auto=${auto ? 1 : 0}`);
      if (auto) o.onAutoStop?.();
    };

    try {
      const r = o.bitsPerSecond === undefined ? new MediaRecorder(stream) : new MediaRecorder(stream, { audioBitsPerSecond: o.bitsPerSecond });
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
