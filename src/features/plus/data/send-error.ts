// 送服务器函数（ai-parse、ai-voice）失败的种类和异常：fn-post 的 postFn 抛，打字流程（type-flow）和录音流程（voice-flow）都经 withTimeoutRetry 送、归类、判要不要自动重试。
// 单独成一个文件：fn-post 引它不用顺带引进 type-flow 和本机解析库（claude-link-api 只要 sendFn），record-logic 引类型也不用绕一圈。
// 纯 TS：不准 import React（A1）
import { isAbortErr } from '../../../platform/env.ts';
import { canAutoRetry } from './record-logic.ts';

/** 失败的种类：network = 连接都没建立（fetch 抛 TypeError）；其余都不自动重试 */
export type SendFail = 'network' | 'timeout' | 'http' | 'bad_response';

export class SendError extends Error {
  readonly fail: SendFail;
  constructor(fail: SendFail) {
    super(fail);
    this.fail = fail;
    this.name = 'SendError';
  }
}

/** 送出途中抛出来的东西归成哪一种（打字、录音共用）：SendError 照它；超时、取消算 timeout；fetch 的 TypeError 算 network（连接都没建立）；别的算 http */
export function sendFailOf(e: unknown): SendFail {
  if (e instanceof SendError) return e.fail;
  if (isAbortErr(e)) return 'timeout';
  if (e instanceof TypeError) return 'network';
  return 'http';
}

/** 送一次的结局：ok 带回原样的返回；不 ok 是失败种类（cancelled = 调用方给的 signal 取消了）；tries = 一共送了几次 */
export type Tried<T> = { ok: true; value: T; tries: number } | { ok: false; fail: SendFail | 'cancelled'; tries: number };

/** 打字（askAi）、录音（sendVoice）共用的“超时 + 归类 + 自动重试”：每次 timeoutMs 掐断；只在连接都没建立（network）时自动重试 1 次，
 *  重试前浏览器已经明确说离线就不重试；outer 是用户点“取消”（打字不给） */
export async function withTimeoutRetry<T>(run: (signal: AbortSignal) => Promise<T>, timeoutMs: number, online: () => boolean, outer?: AbortSignal): Promise<Tried<T>> {
  for (let tried = 0; ; tried++) {
    if (outer?.aborted) return { ok: false, fail: 'cancelled', tries: tried };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new DOMException('timeout', 'TimeoutError')), timeoutMs);
    const stop = (): void => ac.abort(new DOMException('cancelled', 'AbortError'));
    outer?.addEventListener('abort', stop, { once: true });
    try {
      return { ok: true, value: await run(ac.signal), tries: tried + 1 };
    } catch (e) {
      const fail = outer?.aborted ? 'cancelled' : ac.signal.aborted ? 'timeout' : sendFailOf(e);
      if (fail === 'cancelled' || !canAutoRetry(fail, tried) || !online()) return { ok: false, fail, tries: tried + 1 };
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener('abort', stop);
    }
  }
}
