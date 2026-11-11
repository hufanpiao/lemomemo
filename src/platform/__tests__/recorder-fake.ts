// recorder.test.ts、recorder-cancel.test.ts 共用：假的 MediaRecorder、假麦克风、开录到 start 事件的捷径、接运行日志
import { afterEach, beforeEach, vi } from 'vitest';
import { MIC_PERM_KEY } from '../perm-mic.ts';
import { startRecorder, type RecorderOptions } from '../recorder.ts';
import { RL_SLOT } from '../run-log-api.ts';

export const MAX_MS = 60_000;
export const MAX_BYTES = 600 * 1024;

export class FakeRecorder extends EventTarget {
  static made: FakeRecorder[] = [];
  static ctorThrows: Error | null = null;
  static startThrows: Error | null = null;
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/mp4;codecs=mp4a.40.2';
  readonly ctorArgs: unknown[];
  readonly startArgs: unknown[][] = [];
  stopCalls = 0;
  /** stop() 以后吐出来的各片 */
  chunks: Blob[] = [new Blob([new Uint8Array(100)])];

  constructor(...args: unknown[]) {
    super();
    if (FakeRecorder.ctorThrows) throw FakeRecorder.ctorThrows;
    this.ctorArgs = args;
    FakeRecorder.made.push(this);
  }
  start(...args: unknown[]): void {
    if (FakeRecorder.startThrows) throw FakeRecorder.startThrows;
    this.startArgs.push(args);
    this.state = 'recording';
  }
  /** 和真的一样：先交出数据，再发 stop 事件，都在调用之后 */
  stop(): void {
    this.stopCalls += 1;
    this.state = 'inactive';
    queueMicrotask(() => this.endNow());
  }
  fireStart(): void {
    this.dispatchEvent(new Event('start'));
  }
  fireError(name = 'UnknownError'): void {
    this.dispatchEvent(Object.assign(new Event('error'), { error: new DOMException('x', name) }));
  }
  /** 交出数据并发 stop 事件（系统把轨道收走时不经 stop() 也会这样） */
  endNow(): void {
    this.state = 'inactive';
    for (const data of this.chunks) this.dispatchEvent(Object.assign(new Event('dataavailable'), { data }));
    this.dispatchEvent(new Event('stop'));
  }
}

export interface Mic {
  getUserMedia: ReturnType<typeof vi.fn>;
  tracks: { stop: ReturnType<typeof vi.fn> }[];
  stream: MediaStream;
}

export function mic(result: 'ok' | Error | Promise<MediaStream> = 'ok'): Mic {
  const tracks = [{ stop: vi.fn() }, { stop: vi.fn() }];
  const stream = { getTracks: () => tracks } as unknown as MediaStream;
  const getUserMedia = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result === 'ok' ? stream : result;
  });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  return { getUserMedia, tracks, stream };
}

/** 测试环境里 DOMException 不一定是 Error 的实例，桩用带 name 的 Error（归类只看 name） */
export const named = (name: string): Error => Object.assign(new Error('x'), { name });
export const allClosed = (m: Mic): boolean => m.tracks.every((t) => t.stop.mock.calls.length > 0);
export const opts = (over: Partial<RecorderOptions> = {}): RecorderOptions => ({ maxMs: MAX_MS, maxBytes: MAX_BYTES, now: () => 0, ...over });
export const flush = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);
export const rec0 = (): FakeRecorder => {
  const r = FakeRecorder.made[0];
  if (!r) throw new Error('还没建录音器');
  return r;
};

/** 开录并等到 start 事件：返回已经在录的那一个 */
export async function recording(over: Partial<RecorderOptions> = {}) {
  const p = startRecorder(opts(over));
  await flush();
  rec0().fireStart();
  const r = await p;
  if (!r.ok) throw new Error(`没开起来：${r.fail}`);
  return r.rec;
}

/** 每条用例前后：假计时器、假录音器、清记下的权限、接上运行日志；返回这条用例记下的日志 */
export function recorderEnv(): { lines: string[] } {
  const log = { lines: [] as string[] };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    FakeRecorder.made = [];
    FakeRecorder.ctorThrows = null;
    FakeRecorder.startThrows = null;
    localStorage.removeItem(MIC_PERM_KEY);
    log.lines = [];
    (globalThis as Record<string, unknown>)[RL_SLOT] = { q: [], sink: (l: string) => log.lines.push(l) };
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>)[RL_SLOT];
  });
  return log;
}
