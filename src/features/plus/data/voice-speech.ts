// 手机自带识别这一路（B3 任务单 FA-3；架构 5.11 第 5 点 Web Speech）。11-18 起有系统识别就主走这一路（why=live），录音这一路只在没有识别、识别用不了时走：
// • createSpeechRoute：识别本身的生命周期（从 hooks/useVoice.ts 拆出来）
// • createSpeechPath：这一路在控制器里怎么走：开、边说边出字、手指还按着识别自己先结束就重开、松手先存（voice-live.ts 的 createQuickSave）、AI 后台整理
// • start() 必须在用户手势里调：按下那一下就先开（prime），按满 350 ms 接手（take），没按满就关掉（drop）
// • 先开的那一次可能在接手之前就已经开始收音（at），甚至已经结束（early）：接手时补上
// • 整段计时、60 秒上限（REC_MAX_MS，和录音同一个上限）从这一次第一次开始收音算，中途重开不重新算（11-18 语音整块评审第 5 条）；到了交给 host.cap()（当松手处理）
// • 只有接手了的那一次的开始、结束、中途的字才报给 host；先开又被关掉的不报
// 纯 TS：不准 import React（A1）
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { speechSupported, startSpeech, type SpeechEnd, type SpeechSession } from '../../../platform/speech.ts';
import { REC_MAX_MS } from './record-logic.ts';
import type { Attempt, SpeechWhy, VoiceCore } from './voice-session.ts';

/** voice-live.ts 的 createQuickSave 给的：先存、后台整理 */
type QuickSave = (a: Attempt, text: string, t0: number) => Promise<void>;

/** 报给谁（下面 createSpeechPath） */
export interface SpeechHost {
  /** 接手的这一次开始收音了 */
  started(): void;
  /** 接手的这一次结束了：文字，或失败原因 */
  ended(res: SpeechEnd): void;
  /** 整段收了 60 秒 */
  cap(): void;
  /** 接手的这一次到现在为止认出的全文（已定稿 + 没定稿） */
  text(t: string): void;
}

interface Run {
  s: SpeechSession;
  /** start 事件到了的时刻（还没到 null） */
  at: number | null;
  /** 还没接手就结束了 */
  early: SpeechEnd | null;
  /** 到现在为止认出的字 */
  said: string;
}

export function createSpeechRoute(host: SpeechHost, now: () => number = () => performance.now()) {
  let pending: Run | null = null;
  let active: Run | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 这一整段第一次开始收音的时刻（重开接着算；新开一段、关掉时清） */
  let origin: number | null = null;

  const clear = (): void => {
    clearTimeout(timer);
    origin = null;
  };
  /** 接手的这一次开始收音了：整段还没起点就从这里起算、上 60 秒的表 */
  const began = (at: number): void => {
    if (origin === null) {
      origin = at;
      clearTimeout(timer);
      timer = setTimeout(() => host.cap(), Math.max(0, REC_MAX_MS - (now() - at)));
    }
    host.started();
  };
  const end = (run: Run, res: SpeechEnd): void => {
    if (active !== run) return;
    active = null;
    host.ended(res);
  };
  const open = (lang: Locale): Run | null => {
    if (!speechSupported()) return null;
    let run: Run | null = null;
    const r = startSpeech(lang, {
      onStart: () => {
        if (!run) return;
        run.at = now();
        if (active === run) began(run.at);
      },
      onEnd: (res) => {
        if (!run) return;
        if (active === run) end(run, res);
        else run.early = res;
      },
      onText: (t: string) => {
        if (!run) return;
        run.said = t;
        if (active === run) host.text(t);
      },
    });
    if (!r.ok) return null;
    run = { s: r.session, at: null, early: null, said: '' };
    return run;
  };
  /** 只关先开、还没接手的那次（点一下、没按满） */
  const drop = (): void => {
    pending?.s.cancel();
    pending = null;
  };

  return {
    /** 按下的那一下先开（lang 是界面语言 zh-CN / ko-KR）；之前先开的那次关掉 */
    prime(lang: Locale): void {
      drop();
      pending = open(lang);
    },
    /** 接手：先开的那次，没有就当场开一次。开不起来返回 false。
     *  cont：手指还按着、识别自己先结束了的重开，整段计时和 60 秒上限接着算 */
    take(lang: Locale, cont = false): boolean {
      // 还接手着的旧的那次先关掉（不报结果），免得两个同时在听
      active?.s.cancel();
      active = null;
      if (!cont) clear();
      const run = pending ?? open(lang);
      pending = null;
      if (!run) return false;
      active = run;
      if (run.said !== '') host.text(run.said);
      if (run.early) end(run, run.early);
      else if (run.at !== null) began(run.at);
      return true;
    },
    /** 松手：停止收音，等结果（结果经 host.ended 回来） */
    stop(): void {
      active?.s.stop();
    },
    /** 丢掉：接手的和先开的都关，不报结果 */
    cancel(): void {
      active?.s.cancel();
      active = null;
      clear();
      drop();
    },
    /** 这一整段收完了（拿到结局以后）：60 秒的表停掉 */
    done: clear,
    drop,
    /** 这一整段开始收音多久了（毫秒；还没开始 0） */
    elapsed: (): number => (origin === null ? 0 : now() - origin),
  };
}

/** 两段认出的字接起来（韩文按词隔空格） */
export const joinSaid = (lang: Locale, a: string, b: string): string => (a === '' ? b : b === '' ? a : `${a}${lang === 'ko-KR' ? ' ' : ''}${b}`);

/** 声波跟着认出的字跳：来一次新字跳到这么高，PULSE_MS 内落回 0（识别拿不到音量，不是真实音量） */
const PULSE = 0.7;
const PULSE_MS = 350;
/** 手指按着时识别自己结束、重开，最多这么多次（iOS 每停顿一下就结束一次；防重开立刻又结束的死循环） */
export const SPEECH_RESTARTS_MAX = 20;

/**
 * 控制器里的这一路（voice-session.ts 调）：
 * • 边说边出字：认出的字（前几段 + 这一段已定稿和没定稿）放进 view 的 live 给面板画；
 * • 手指还按着、识别自己先结束了（iOS 说话停顿后常这样）：重开，新认出的接在后面，一直到松手或 60 秒（第 4 条：原来只重开一次，第二次停顿就丢后半句）；
 *   重开开不起来、重开的那次报错：拿前几段已有的字收尾，不扔（第 3 条）；
 * • 松手（或识别自己结束收尾）以后整段文字一律先按本机规则存、AI 后台整理（第 10 条：额度、网慢、没开 AI 时 AI 本来就不调或调了也等，不再让人干等）；
 * • why=live 这一次识别异步报错（iOS 关了 Siri 和听写时 start 之后才回 service-not-allowed 等）而一个字都没认出：报给 onLiveFail，
 *   控制器这次打开 app 期间改走录音，下次按住就能用（第 1 条：原来每按一次都失败一次）
 */
export function createSpeechPath(c: VoiceCore, quick: QuickSave, onLiveFail: () => void, now: () => number = () => performance.now()) {
  const lang = (): Locale => c.d().lang;
  let why: SpeechWhy = 'live';
  /** 这一段属于哪一次（第 14 条：结局、中途的字只认开它的那一次） */
  let mine: Attempt | null = null;
  /** 松手（或识别自己收尾）的时刻：后台整理多久算太晚、日志 ms= 从这里算（第 2 条：原来只在 stop() 里设，自己收尾时是 0 或上一次的） */
  let t0 = 0;
  /** 这一次前几段认出的字、重开过几次、松手了没有、最近一次来新字的时刻 */
  let prev = '';
  let restarts = 0;
  let stopping = false;
  let textAt = -Infinity;
  const reset = (): void => {
    mine = null;
    prev = '';
    restarts = 0;
    stopping = false;
    textAt = -Infinity;
    c.set({ live: '' });
  };
  const heard = async (a: Attempt, res: SpeechEnd): Promise<void> => {
    route.done();
    c.set({ live: '' });
    if (!stopping) t0 = now();
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
    await quick(a, res.text, t0);
  };
  const route = createSpeechRoute(
    {
      started() {
        if (c.view().status === 'preparing') c.go({ type: 'start', path: 'speech' });
      },
      text(t) {
        if (!mine || c.current() !== mine) return;
        textAt = now();
        c.set({ live: joinSaid(lang(), prev, t) });
      },
      ended(res) {
        const a = mine;
        if (!a || c.current() !== a) return;
        const held = !stopping && c.view().status === 'listening';
        // 手指还按着、识别自己先结束了：重开，新认出的接在后面
        if (res.ok && held && restarts < SPEECH_RESTARTS_MAX) {
          prev = joinSaid(lang(), prev, res.text);
          restarts += 1;
          const ok = route.take(lang(), true);
          rlog(`voice speech restart n=${restarts} ok=${ok ? 1 : 0} len=${[...prev].length}`);
          if (ok) return;
          return void heard(a, { ok: true, text: prev });
        }
        // 前几段已经认出了字：这一次报错、停录超时也拿已有的字收尾
        if (!res.ok && prev !== '') {
          rlog(`voice speech keep_prev fail=${res.fail} len=${[...prev].length}`);
          return void heard(a, { ok: true, text: prev });
        }
        // 麦克风被拒（not-allowed）出说明卡、录音一样会被拒，不改路；网络、停录超时是这一次的事，不改路
        if (!res.ok && why === 'live' && res.fail === 'error') {
          rlog(`voice speech live_fail fail=${res.fail}`);
          onLiveFail();
        }
        void heard(a, res.ok ? { ok: true, text: joinSaid(lang(), prev, res.text) } : res);
      },
      cap: () => c.finish(),
    },
    now,
  );
  return {
    prime: () => route.prime(lang()),
    /** 接手（或当场开）；lockedNow：“再说一次”，面板直接是锁定的样子。开不起来返回 false（live 那一路由调用方退回录音上传，不提示） */
    begin(w: SpeechWhy, lockedNow: boolean): boolean {
      reset();
      why = w;
      const a = c.begin();
      mine = a;
      c.set({ path: 'speech', why: w });
      rlog(`voice speech why=${w}`);
      c.go({ type: 'prepare' });
      if (lockedNow) c.go({ type: 'lock' });
      if (route.take(lang())) return true;
      rlog(`voice speech take_fail why=${w}`);
      c.end(a);
      mine = null;
      // live：调用方（voice-session start）当场接着开录音，面板留在“准备中”，不先回空闲。
      // 先回空闲那一下“正在收音”变成否，按住手势会被 voice-sink 当成结束清掉，松手就没人收、录音停不下来（11-18 单测日志定的）
      if (w === 'live') return false;
      c.toIdle();
      c.show('speech_off');
      return false;
    },
    /** 松手：面板收起，进“正在整理”；停不下来时 platform/speech.ts 最多等 SPEECH_STOP_WAIT_MS */
    stop() {
      if (c.view().status !== 'listening') return;
      stopping = true;
      t0 = now();
      c.go({ type: 'organize' });
      route.stop();
    },
    cancel(): void {
      route.cancel();
      reset();
    },
    drop: () => route.drop(),
    elapsed: () => route.elapsed(),
    /** 声波高度 0～1：来新字那一下 PULSE，PULSE_MS 内线性落回 0 */
    level: (): number => PULSE * Math.max(0, 1 - (now() - textAt) / PULSE_MS),
  };
}
