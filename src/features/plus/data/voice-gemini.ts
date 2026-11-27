// 按住“＋”的 Gemini 实时转写（不用系统识别器，录音加云端转写边说边出字）：挂在录音这一路（voice-rec.ts 的 RecTap）上，录音器照旧录，麦克风只开一路。
// • 按下（走录音这一路、开关开着）：预取 platform/live-transcribe.ts（按满 350 ms 时多半已经下好）
// • 按住满 350 ms（还在手势里）：同步建音频上下文（platform/live-audio.ts），同时向 ai-live-token 要短期令牌（live-token-api.ts，最多等 LIVE_TOKEN_WAIT_MS；
//   这一次收拾掉时没回来的请求一并中止）。令牌回了“今天用完”：当场交给录音这一路停录、提示、记下剩 0 次（voice-rec.ts 的 stopNow，
//   不让人白说）；“没同意”：记下，松手直接按这个结果收尾，不上传录音（发令牌只看不扣，一句话只由后台整理的 ai-voice 扣一次；
//   出了字先存只按本机规则，不调 ai-parse）
// • 录音器拿到麦克风流：懒加载的 live-transcribe 接上采音；令牌到了就连 Gemini，中间结果实时放进面板的出字框（view.live）
// • 声波用 worklet 量到的真实麦克风电平；采音接不上时退回录音器自己的音量计
// • 松手那一刻（release，停录之前）就开始收尾：冻结采音、发结束，和录音器停录并行；不等定稿（等定稿会干等好几秒还常常 n_final=0）。
//   录音器交了结局以后，屏幕上已出的字（定稿 + 正在说的）不是空的就交回 { text }，由 voice-rec.ts 当场存、
//   后台用这段录音交 ai-voice 补全（voice-pending.ts 的 tidyLater）；中途断线、积压太多时已出的半截字也照样交回，后台录音补；
//   录音器停止失败（没交出录音）时已出的字也照样交回，voice-rec 只存字、不排后台整理
//   令牌拿不到、连不上、一个字都没出：交回 upload，照旧先存“整理中”占位、录音上传 ai-voice（voice-pending.ts）
//   发出的音比录音短、开头缺一截（sent_ms、head_ms）只记在日志里、不改走上传：后台 ai-voice 用的是完整录音，缺的字会补上
// • 丢掉、取消（这一次的 signal）：中止令牌请求、关连接、断开节点、关音频上下文
// • 运行日志：voice gem begin / end（连上毫秒、首个字毫秒、字数、发出和录到的毫秒、开头差、积压、中间结果 / 定稿 / modelTurn 条数）/ fallback why= / stop why=；不记说的字
// 纯 TS：不准 import React
import { closeAudioCtx, openAudioCtx } from '../../../platform/live-audio.ts';
import type { LiveEnd, LiveOpts, LiveSession } from '../../../platform/live-transcribe.ts';
import type { RecEnd } from '../../../platform/recorder.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import type { Locale } from '../../../../shared/i18n/i18n.ts';
import { fetchLiveToken, type LiveTokenRes } from './live-token-api.ts';
import type { VoiceResult } from './voice-flow.ts';
import type { RecTap, TapOut } from './voice-rec.ts';
import type { Attempt, VoiceCore } from './voice-session.ts';

/** 要令牌最多等多久：再晚说的话就攒太多了，直接走录音上传 */
export const LIVE_TOKEN_WAIT_MS = 5000;

/** 测试换桩：要令牌、开会话 */
export interface LiveIo {
  token?: ((locale: Locale, signal: AbortSignal) => Promise<LiveTokenRes>) | undefined;
  open?: ((o: LiveOpts) => Promise<LiveSession>) | undefined;
}

interface Run {
  a: Attempt;
  ctx: AudioContext | null;
  /** 令牌请求的中止（这一次收拾掉时中止） */
  tokAc: AbortController;
  tok: Promise<LiveTokenRes>;
  sess: LiveSession | null;
  /** 这次实时转写已经用不了的原因（松手直接上传）；null = 还好着 */
  why: string | null;
  /** 令牌回了今天用完、没同意：松手按这个收尾、不上传 */
  res: VoiceResult | null;
  /** 录音器开录的时刻（now 的时钟） */
  recAt: number | null;
  /** 松手时开始的收尾 */
  fin: Promise<LiveEnd> | null;
  done: boolean;
}

const load = () => import('../../../platform/live-transcribe.ts');

/** 等令牌，最多 ms 毫秒；到点、这一次作废、ac 被中止都回超时 */
function tokenWithin(get: (signal: AbortSignal) => Promise<LiveTokenRes>, ac: AbortController, parent: AbortSignal, ms: number): Promise<LiveTokenRes> {
  const stop = (): void => ac.abort();
  parent.addEventListener('abort', stop, { once: true });
  const t = setTimeout(stop, ms);
  return get(ac.signal)
    .catch((): LiveTokenRes => ({ ok: false, why: ac.signal.aborted ? 'timeout' : 'error' }))
    .finally(() => {
      clearTimeout(t);
      parent.removeEventListener('abort', stop);
    });
}

/** 令牌的哪些结果松手直接收尾、不上传 */
const stopOf = (t: LiveTokenRes): VoiceResult | null =>
  t.ok ? null : t.why === 'quota_out' ? { kind: 'quota_out' } : t.why === 'consent' ? { kind: 'consent_required' } : null;

export function createGeminiTap(c: VoiceCore, io: LiveIo = {}, now: () => number = () => performance.now()): RecTap & { prefetch(): void } {
  const token = io.token ?? fetchLiveToken;
  const open = io.open ?? ((o: LiveOpts): Promise<LiveSession> => load().then((m) => m.openLive(o)));
  let run: Run | null = null;

  const off = (r: Run, why: string): void => {
    if (r.why !== null) return;
    r.why = why;
    rlog(`voice gem off why=${why}`);
  };
  /** 收拾这一次：中止令牌请求、关连接、断节点、关音频上下文（只一次） */
  const cleanup = (r: Run): void => {
    if (r.done) return;
    r.done = true;
    r.tokAc.abort();
    r.sess?.close();
    closeAudioCtx(r.ctx);
    if (run === r) run = null;
  };

  /** 接上采音，令牌到了就连 */
  const attach = async (r: Run, stream: MediaStream): Promise<void> => {
    if (!r.ctx) return off(r, 'no_ctx');
    let sess: LiveSession;
    try {
      sess = await open({
        ctx: r.ctx,
        stream,
        lang: c.d().lang,
        now,
        onText: (t) => {
          if (!r.done && c.current() === r.a) c.set({ live: t });
        },
      });
    } catch (e) {
      return off(r, `audio_${e instanceof Error ? e.name : 'unknown'}`);
    }
    if (r.done) return sess.close();
    r.sess = sess;
    const t = await r.tok;
    if (r.done) return;
    if (!t.ok) {
      off(r, `token_${t.why}`);
      return sess.fail(t.why);
    }
    sess.connect(t.t);
  };

  return {
    prefetch() {
      if (!io.open) void load().catch(() => undefined);
    },
    begin(a, stop) {
      if (run) cleanup(run);
      // 还在按住手势里：音频上下文必须这时建（iOS 不在手势里建的起不来）
      const ctx = openAudioCtx();
      const tokAc = new AbortController();
      const r: Run = {
        a, ctx, tokAc, tok: tokenWithin((s) => token(c.d().lang, s), tokAc, a.ac.signal, LIVE_TOKEN_WAIT_MS),
        sess: null, why: null, res: null, recAt: null, fin: null, done: false,
      };
      run = r;
      void r.tok.then((t) => {
        r.res = stopOf(t);
        // 今天用完：不等松手，当场停录、提示（这一次已收拾掉的不管）
        if (r.res?.kind === 'quota_out' && !r.done) stop(r.res);
      });
      a.ac.signal.addEventListener('abort', () => cleanup(r), { once: true });
      rlog(`voice gem begin ctx=${ctx?.state ?? 'none'}`);
    },
    stream(s) {
      const r = run;
      if (r && !r.done) void attach(r, s);
    },
    started(a) {
      const r = run;
      if (r && r.a === a) r.recAt = now();
    },
    level() {
      const r = run;
      if (!r) return -1;
      if (r.sess) return r.sess.level();
      // 还在接：平着；接不上：交给录音器自己的音量计
      return r.why === null ? 0 : -1;
    },
    release(a) {
      const r = run;
      if (!r || r.a !== a || r.done || !r.sess || r.why !== null || r.res) return;
      r.fin = r.sess.finish();
    },
    async settle(a: Attempt, end: RecEnd): Promise<TapOut> {
      const r = run;
      if (!r || r.a !== a) return 'upload';
      const t0 = now();
      if (end.ok && r.res) {
        rlog(`voice gem stop why=${r.res.kind}`);
        const res = r.res;
        cleanup(r);
        return { res };
      }
      // 会话没接上、半路用不了：退回上传（录音器也没交出录音的，由 voice-rec 按原因提示）
      if (!r.sess || r.why !== null) {
        if (end.ok) rlog(`voice gem fallback why=${r.why ?? 'no_session'}`);
        cleanup(r);
        return 'upload';
      }
      // 录音器停止失败（end.ok 为假）时会话里已经出了的字照样取出来：voice-rec 只存字、不排后台整理
      const e = await (r.fin ?? r.sess.finish());
      cleanup(r);
      if (!c.alive(a, 'gem_end')) return 'done';
      const s = e.stats;
      const head = s.audioAt === null || r.recAt === null ? null : Math.round(s.audioAt - r.recAt);
      rlog(
        `voice gem end ok=${e.ok ? 1 : 0}${e.ok ? '' : ` why=${e.why}`} conn_ms=${s.connMs ?? -1} first_ms=${s.firstMs ?? -1} len=${s.len} cap_ms=${s.capMs} sent_ms=${s.sentMs} rec_ms=${end.ok ? end.clip.ms : -1} head_ms=${head ?? -1} backlog_ms=${s.backlogMs} n_interim=${s.nInterim} n_final=${s.nFinal} n_model=${s.nModel} wait_ms=${Math.round(now() - t0)}`,
      );
      // 已出的字就是要存的（见文件头）；一个字都没出才退回上传
      const text = e.text.trim();
      if (text === '') {
        rlog(`voice gem fallback why=${e.ok ? 'empty' : e.why}`);
        return 'upload';
      }
      return { text };
    },
  };
}
