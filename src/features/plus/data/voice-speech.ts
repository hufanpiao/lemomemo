// 手机自带识别这一路（B3 任务单 FA-3；架构 5.11 第 5 点 Web Speech 兜底）：
// • createSpeechRoute：识别本身的生命周期（从 hooks/useVoice.ts 拆出来）
// • createSpeechPath：这一路在控制器里怎么走（第二轮复查项从 voice-session.ts 挪来）：开、停、拿到文字走打字同一套 planTyped、存
// • start() 必须在用户手势里调：按下那一下就先开（prime），按满 350 ms 接手（take），没按满就关掉（drop）
// • 先开的那一次可能在接手之前就已经开始收音（at），甚至已经结束（early）：接手时补上
// • 开始收音以后最长 60 秒（REC_MAX_MS，和录音同一个上限）到了交给 host.cap()（useVoice 当松手处理）
// • 只有接手了的那一次的开始、结束才报给 host；先开又被关掉的不报
// 纯 TS：不准 import React（A1）
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { speechSupported, startSpeech, type SpeechEnd, type SpeechSession } from '../../../platform/speech.ts';
import { quotaOutToday, rememberQuotaLeft } from './quota.ts';
import { REC_MAX_MS } from './record-logic.ts';
import { planTyped } from './type-flow.ts';
import type { Attempt, SpeechWhy, VoiceCore } from './voice-session.ts';

/** 报给谁（useVoice） */
export interface SpeechHost {
  /** 接手的这一次开始收音了 */
  started(): void;
  /** 接手的这一次结束了：文字，或失败原因 */
  ended(res: SpeechEnd): void;
  /** 收了 60 秒 */
  cap(): void;
}

export interface SpeechRoute {
  /** 按下的那一下先开（lang 是界面语言 zh-CN / ko-KR）；之前先开的那次关掉 */
  prime(lang: Locale): void;
  /** 接手：先开的那次，没有就当场开一次（调用方也在手势里）。开不起来返回 false */
  take(lang: Locale): boolean;
  /** 松手：停止收音，等结果（结果经 host.ended 回来） */
  stop(): void;
  /** 丢掉：接手的和先开的都关，不报结果 */
  cancel(): void;
  /** 只关先开、还没接手的那次（点一下、没按满） */
  drop(): void;
  /** 接手的这一次开始收音多久了（毫秒；还没开始 0） */
  elapsed(): number;
}

interface Run {
  s: SpeechSession;
  /** start 事件到了的时刻（还没到 null） */
  at: number | null;
  /** 还没接手就结束了 */
  early: SpeechEnd | null;
}

export function createSpeechRoute(host: () => SpeechHost | null, now: () => number = () => performance.now()): SpeechRoute {
  let pending: Run | null = null;
  let active: Run | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => host()?.cap(), REC_MAX_MS);
  };
  const end = (run: Run, res: SpeechEnd): void => {
    if (active !== run) return;
    active = null;
    clearTimeout(timer);
    host()?.ended(res);
  };
  const open = (lang: Locale): Run | null => {
    if (!speechSupported()) return null;
    let run: Run | null = null;
    const r = startSpeech(lang, {
      onStart: () => {
        if (!run) return;
        run.at = now();
        if (active !== run) return;
        arm();
        host()?.started();
      },
      onEnd: (res) => {
        if (!run) return;
        if (active === run) end(run, res);
        else run.early = res;
      },
    });
    if (!r.ok) return null;
    run = { s: r.session, at: null, early: null };
    return run;
  };
  const drop = (): void => {
    pending?.s.cancel();
    pending = null;
  };

  return {
    prime(lang) {
      drop();
      pending = open(lang);
    },
    take(lang) {
      const run = pending ?? open(lang);
      pending = null;
      if (!run) return false;
      active = run;
      if (run.early) end(run, run.early);
      else if (run.at !== null) {
        arm();
        host()?.started();
      }
      return true;
    },
    stop() {
      active?.s.stop();
    },
    cancel() {
      active?.s.cancel();
      active = null;
      clearTimeout(timer);
      drop();
    },
    drop,
    elapsed() {
      const at = active?.at ?? null;
      return at === null ? 0 : now() - at;
    },
  };
}

/** 控制器里的这一路（voice-session.ts 调） */
export function createSpeechPath(c: VoiceCore) {
  const lang = (): Locale => (c.d().ctx().locale === 'ko' ? 'ko-KR' : 'zh-CN');
  const heard = async (a: Attempt, res: SpeechEnd): Promise<void> => {
    if (!res.ok) {
      c.end(a);
      c.toIdle();
      if (res.fail === 'denied') c.go({ type: 'card', card: 'denied' });
      else c.show(res.fail === 'network' ? 'speech_net' : res.fail === 'timeout' ? 'not_heard' : 'speech_off');
      return;
    }
    if (c.view().status === 'preparing') c.go({ type: 'start', path: 'speech' });
    if (res.text === '') {
      c.end(a);
      c.go({ type: 'no_speech' });
      c.show('no_speech');
      return;
    }
    if (c.view().status !== 'organizing') c.go({ type: 'organize' });
    const d = c.d();
    const x = d.ctx();
    const on = d.aiOn();
    const qOut = on ? await quotaOutToday(x.now) : false;
    if (!c.alive(a, 'speech_quota')) return;
    const p = await planTyped(res.text, x, { online: d.online(), isOnline: d.online, aiOn: on, quotaOut: qOut }, d.callAi);
    if (!c.alive(a, 'speech_plan')) return;
    if (p.quotaLeft !== null) void rememberQuotaLeft(p.quotaLeft, x.now);
    await c.savePlan(a, p, res.text);
  };
  const route = createSpeechRoute(() => ({
    started() {
      if (c.view().status === 'preparing') c.go({ type: 'start', path: 'speech' });
    },
    ended(res) {
      const a = c.current();
      if (a) void heard(a, res);
    },
    cap: () => c.finish(),
  }));
  return {
    prime: () => route.prime(lang()),
    /** 接手（或当场开）；lockedNow：“再说一次”，面板直接是锁定的样子 */
    begin(w: SpeechWhy, lockedNow: boolean) {
      const a = c.begin();
      c.set({ path: 'speech', why: w });
      rlog(`voice speech why=${w}`);
      c.go({ type: 'prepare' });
      if (lockedNow) c.go({ type: 'lock' });
      if (route.take(lang())) return;
      c.end(a);
      c.toIdle();
      c.show('speech_off');
    },
    /** 松手：面板收起，进“正在整理”；停不下来时 platform/speech.ts 最多等 SPEECH_STOP_WAIT_MS */
    stop() {
      if (c.view().status !== 'listening') return;
      c.go({ type: 'organize' });
      route.stop();
    },
    cancel: () => route.cancel(),
    drop: () => route.drop(),
    elapsed: () => route.elapsed(),
  };
}
