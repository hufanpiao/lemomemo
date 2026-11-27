// 按住“＋”走 Gemini 实时转写时，必须在按住手势里同步做的几件小事；真正的采音、连接在
// platform/live-transcribe.ts（按住时才懒加载，不进首屏）。AudioContext 按 A13 只准写在 platform。
// • liveSupported：这台浏览器能不能走（AudioWorklet + WebSocket）；不能就照旧只录音上传
// • openAudioCtx：在手势里同步建音频上下文并 resume（iOS 不在手势里建的是 suspended，采不到音），建不了回 null
// • 诊断开关 Gemini live（设置诊断区）：默认 ON，OFF 时这次打开 App 只用录音上传；只存 sessionStorage，'1' = 关
import { errTag } from './err-tag.ts';
import { rlog } from './run-log-api.ts';

const OFF_KEY = 'lemo-gemini-live-off';

export function geminiLiveOn(store: Storage = sessionStorage): boolean {
  try {
    return store.getItem(OFF_KEY) !== '1';
  } catch {
    return true;
  }
}
export function setGeminiLiveOn(on: boolean, store: Storage = sessionStorage): void {
  try {
    if (on) store.removeItem(OFF_KEY);
    else store.setItem(OFF_KEY, '1');
  } catch {
    /* 存不了：照默认 */
  }
}

type Ctor = typeof AudioContext;
/** 这台浏览器的 AudioContext 构造函数（老 Safari 只有 webkitAudioContext）；没有回 null。只此一份 */
export const audioCtxCtor = (): Ctor | null => {
  const g = globalThis as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
};

export function liveSupported(): boolean {
  const g = globalThis as { AudioWorkletNode?: unknown; WebSocket?: unknown };
  return audioCtxCtor() !== null && typeof g.AudioWorkletNode === 'function' && typeof g.WebSocket === 'function';
}

/** 在手势里同步建、同步调 resume；建不了回 null（记一行） */
export function openAudioCtx(): AudioContext | null {
  const C = audioCtxCtor();
  if (!C) return null;
  try {
    const ctx = new C();
    void ctx.resume().catch((e: unknown) => rlog(`live ctx resume_fail${errTag(e)}`));
    return ctx;
  } catch (e) {
    rlog(`live ctx fail${errTag(e)}`);
    return null;
  }
}

export function closeAudioCtx(ctx: AudioContext | null): void {
  if (!ctx || ctx.state === 'closed') return;
  void ctx.close().catch(() => undefined);
}
