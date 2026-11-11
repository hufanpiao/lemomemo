// 手机自带识别（Web Speech）：按界面语言听，边听边出字，结束时交出全文。SpeechRecognition 只在这里用（A13）
// • startSpeech 是同步的，start() 之前没有任何等待：调用方在按下的那一下里直接调，才算在用户手势里
// • onEnd 最多调一次；cancel() 以后什么都不再回调
// • 没认出字不算失败，交出空串，调用方按“没听清”处理
// • 运行日志只记语言、字数、段数、毫秒、错误码，不记识别出的字
import type { Locale } from '../../shared/i18n/i18n.ts';
import { errTag, rlog } from './run-log-api.ts';

export type SpeechFail = 'denied' | 'network' | 'error';
export type SpeechEnd = { ok: true; text: string } | { ok: false; fail: SpeechFail };

export interface SpeechHandlers {
  /** 真的开始听了（start 事件到了）才调 */
  onStart?(): void;
  /** 到现在为止的全文（已定稿的段 + 还没定稿的段） */
  onText?(text: string): void;
  onEnd(r: SpeechEnd): void;
}

export interface SpeechSession {
  /** 说完了，要结果：等 onEnd */
  stop(): void;
  /** 不要了 */
  cancel(): void;
}

/** lib.dom 没有 SpeechRecognition 本体，这里只写用到的那几样 */
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onstart: (() => void) | null;
  onresult: ((ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

function recognitionCtor(): (new () => Recognition) | null {
  const g = globalThis as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  const c = g.SpeechRecognition ?? g.webkitSpeechRecognition;
  return typeof c === 'function' ? (c as new () => Recognition) : null;
}

export const speechSupported = (): boolean => recognitionCtor() !== null;

const FAIL_OF: Readonly<Record<string, SpeechFail>> = { 'not-allowed': 'denied', 'service-not-allowed': 'denied', network: 'network' };
/** 不算失败的错误码：没听到声音（按空串结束）、被中止（等 end 事件收尾） */
const NOT_A_FAILURE: readonly string[] = ['no-speech', 'aborted'];

export function startSpeech(
  lang: Locale,
  h: SpeechHandlers,
  now: () => number = () => performance.now(),
): { ok: true; session: SpeechSession } | { ok: false; fail: 'unsupported' | 'error' } {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    rlog('speech fail reason=unsupported');
    return { ok: false, fail: 'unsupported' };
  }
  const t0 = now();
  const since = (): string => `ms=${Math.round(now() - t0)}`;
  let text = '';
  let segments = 0;
  let begun = false;
  let done = false;
  let r: Recognition;
  try {
    r = new Ctor();
    r.lang = lang;
    r.interimResults = true;
    r.continuous = true;
    r.onstart = () => {
      if (done || begun) return;
      begun = true;
      rlog(`speech start lang=${lang} ${since()}`);
      h.onStart?.();
    };
    r.onresult = (ev) => {
      if (done) return;
      let all = '';
      for (let i = 0; i < ev.results.length; i++) all += ev.results[i]?.[0]?.transcript ?? '';
      text = all;
      segments = ev.results.length;
      h.onText?.(all);
    };
    r.onerror = (ev) => {
      const code = String(ev.error);
      if (done || NOT_A_FAILURE.includes(code)) return;
      done = true;
      const fail = FAIL_OF[code] ?? 'error';
      rlog(`speech fail reason=${fail}${/^[a-z-]{1,40}$/.test(code) ? ` code=${code}` : ''} ${since()}`);
      h.onEnd({ ok: false, fail });
    };
    r.onend = () => {
      if (done) return;
      done = true;
      const said = text.trim();
      rlog(`speech end len=${[...said].length} results=${segments} ${since()}`);
      h.onEnd({ ok: true, text: said });
    };
    r.start();
  } catch (err) {
    done = true;
    rlog(`speech fail reason=error${errTag(err)} ${since()}`);
    return { ok: false, fail: 'error' };
  }
  return {
    ok: true,
    session: {
      stop() {
        if (done) return;
        try {
          r.stop();
        } catch {
          // 已经停了：等 end 事件
        }
      },
      cancel() {
        if (done) return;
        done = true;
        rlog(`speech fail reason=cancelled ${since()}`);
        try {
          r.abort();
        } catch {
          // 已经停了
        }
      },
    },
  };
}
