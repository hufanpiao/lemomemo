// 手机自带识别（Web Speech）：按界面语言听，边听边出字，结束时交出全文。SpeechRecognition 只在这里用（A13）
// • startSpeech 是同步的，start() 之前没有任何等待：调用方在按下的那一下里直接调，才算在用户手势里
// • onEnd 最多调一次；cancel() 以后什么都不再回调
// • 没认出字不算失败，交出空串，调用方按“没听清”处理
// • stop() 以后等 end 最多 SPEECH_STOP_WAIT_MS：iOS 偶尔不发 end，到点按 timeout 收尾并 abort()，调用方不会卡在“在听”
// • 运行日志只记语言、字数、段数、毫秒、错误码，不记识别出的字
import type { Locale } from '../../shared/i18n/i18n.ts';
import { errTag } from './err-tag.ts';
import { safeSet } from './local-store.ts';
import { rlog } from './run-log-api.ts';

/** stop() 以后等 end 事件最长多久（FA-3 整块评审第 2 条） */
export const SPEECH_STOP_WAIT_MS = 3000;

/**
 * 诊断开关（负责人 11-18 录屏“说话没有波动”）：关掉 = 不走系统识别那一路，只用录音上传（真机对比用）。
 * 设置 → 诊断区按钮切换，读不到当开着。
 * 11-19 起只存 sessionStorage（只管这次打开 app，杀掉重开回到 ON）：原来存 localStorage，对比时关掉以后一直关着，
 * 有系统识别也悄悄只走录音、不出字（负责人 11-18：“语音输入正常，但是不出字”）；以前存在 localStorage 的那一份读的时候顺手清掉
 */
const LIVE_OFF_KEY = 'lemo-live-speech-off';
/* 清不了：本来也不再读它 */
const dropOld = (): void => void safeSet(LIVE_OFF_KEY, null);
export function liveSpeechOn(store: Storage = sessionStorage): boolean {
  dropOld();
  try {
    return store.getItem(LIVE_OFF_KEY) !== '1';
  } catch {
    return true;
  }
}
export function setLiveSpeechOn(on: boolean, store: Storage = sessionStorage): void {
  try {
    if (on) store.removeItem(LIVE_OFF_KEY);
    else store.setItem(LIVE_OFF_KEY, '1');
  } catch {
    /* 存不了：照旧开着 */
  }
}

export type SpeechFail = 'denied' | 'network' | 'error' | 'timeout';
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
  onaudiostart: (() => void) | null;
  onspeechstart: (() => void) | null;
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

// service-not-allowed 是系统不给用识别（iOS 关了 Siri 和听写等），麦克风是允许的：算 error，不出“麦克风没有打开”卡（语音整块评审第 1 条）
const FAIL_OF: Readonly<Record<string, SpeechFail>> = { 'not-allowed': 'denied', network: 'network' };
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
  /** 收到几次 result 事件（11-19 观察点：识别起来了、到底有没有回过字，end 那一行带 ev=；第一次来字另记一行 speech result1） */
  let events = 0;
  let begun = false;
  let done = false;
  let wait: ReturnType<typeof setTimeout> | undefined;
  /** 结束只交一次：清兜底计时器再回调 */
  const end = (res: SpeechEnd): void => {
    done = true;
    clearTimeout(wait);
    h.onEnd(res);
  };
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
      events += 1;
      if (events === 1) rlog(`speech result1 len=${[...all.trim()].length} ${since()}`);
      h.onText?.(all);
    };
    // 诊断（负责人 11-17：“有时候说话语音不识别，那个说话时的波动条也不动”）：系统识别什么时候开始收到声音、听出有人说话
    r.onaudiostart = () => rlog(`speech audio_start ${since()}`);
    r.onspeechstart = () => rlog(`speech speech_start ${since()}`);
    r.onerror = (ev) => {
      const code = String(ev.error);
      if (!done && NOT_A_FAILURE.includes(code)) rlog(`speech note code=${code} ${since()}`);
      if (done || NOT_A_FAILURE.includes(code)) return;
      const fail = FAIL_OF[code] ?? 'error';
      rlog(`speech fail reason=${fail}${/^[a-z-]{1,40}$/.test(code) ? ` code=${code}` : ''} ${since()}`);
      end({ ok: false, fail });
    };
    r.onend = () => {
      if (done) return;
      const said = text.trim();
      rlog(`speech end len=${[...said].length} results=${segments} ev=${events} ${since()}`);
      end({ ok: true, text: said });
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
        if (wait !== undefined) return;
        wait = setTimeout(() => {
          if (done) return;
          rlog(`speech fail reason=stop_timeout ${since()}`);
          try {
            r.abort();
          } catch {
            // 已经停了
          }
          end({ ok: false, fail: 'timeout' });
        }, SPEECH_STOP_WAIT_MS);
      },
      cancel() {
        if (done) return;
        done = true;
        clearTimeout(wait);
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
