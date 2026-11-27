// 按住“＋”的录音这一路：开录音器、停录、松手以后先存、留着的录音“重试”
// • 松手（或点“记下”）面板就收起，进“上传中”：停录那一步也能在提示条上取消（录音器停不下来时最多等 REC_STOP_WAIT_MS）
// • 这是唯一的一条路，平时挂 Gemini 实时转写（RecTap，voice-gemini.ts）：边录边出字。
//   松手以后怎么存只在这里分一次（release）：屏幕上出过字（{ text }）→ 当场用这些字存（本机规则拆不出就整句一条待办）；一个字都没出（upload）→
//   当场存占位“语音记录 · 整理中”。两边都是 voice-pending.ts 的 saveNow + tidyLater（录音在后台交 ai-voice 换掉），不让人等 AI；
//   录音器停不下来但已经出了字：只存字，没有录音就不排后台整理、不扣额度；
//   没存上（写库失败）录音留着，提示条“AI 没回应 · 重试”（重试前台上传这段录音）；
//   停录以后的收尾抛了错：记日志、能保住录音就保住、收掉这一次，提示“没保存上”，状态不卡在 uploading
// • 令牌回了没同意：松手按 ai-voice 回同样结果的收法收尾，不上传；
//   令牌回了今天用完：当场停录、提示“语音暂时用不了 · 几点恢复”，记下用完，下次按下直接挡（stopNow）
// • 前台收尾（重试、令牌的结果）和后台整理共用 voice-flow 的 finishVoice（结果映射成动作只此一份），这里只交前台自己怎么存、怎么提示（handle）
// • AI 没回应：录音留在内存（最多 2 分钟）可以“重试”（同一段），或“再说一次”（同一条路重新录）
// • 运行日志：voice rec end rec=录音结局 bytes=字节数（每次松手一行）；voice rec stop_now why=；voice rec stop_err name=；voice rec keep bytes=
// 纯 TS：不准 import React
import { AI_AUDIO_BITS_PER_SECOND, AI_AUDIO_MAX_BYTES, AI_AUDIO_MAX_MS } from '../../../../shared/schema/ai.ts';
import { clock } from '../../../platform/clock.ts';
import { startRecorder, type RecEnd } from '../../../platform/recorder.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { keptExpired, type KeptAudio } from './record-logic.ts';
import { baseReqCtx, planText, type TypeCtx, type TypePlan } from './type-flow.ts';
import { finishVoice, sendVoice, todayTodo, toUpload, type VoiceClip, type VoiceResult } from './voice-flow.ts';
import { createPending, type SavePath } from './voice-pending.ts';
import type { Attempt, VoiceCore } from './voice-session.ts';

/** 开录音器等了这么久还没开起来，当作中间弹过 iOS 系统麦克风框（主屏幕版每次启动第一次按都弹；不弹时约 0.7 秒） */
export const MIC_PROMPT_MS = 1500;

/** 停录以后录音器没交出录音时的提示条种类 */
const recNote = (r: RecEnd | null): 'no_speech' | 'not_heard' | 'rec_failed' =>
  r?.ok === false && r.fail === 'empty' ? 'no_speech' : r?.ok === false && r.fail === 'stop_timeout' ? 'not_heard' : 'rec_failed';

/**
 * 录音这一路上挂的“边录边转写”（Gemini 实时转写，voice-gemini.ts）：录音器照旧录，麦克风只开一路
 * （不另开一路麦克风，两路会抢麦；只在录音器拿到的同一条流上接采音）。
 * begin：这一次开始了（还在按住手势里），stop 是“当场收掉这一次、按这个结果提示”（令牌回了今天用完）；
 * stream：录音器拿到的那条麦克风流（开录之前）；started：录音器开录了；
 * level：真实音量，-1 = 用录音器自己的音量计；release：松手那一刻（停录之前），它先开始收尾、和停录并行；
 * settle：录音器交了结局以后问它怎么收（TapOut）
 */
export interface RecTap {
  begin(a: Attempt, stop: (res: VoiceResult) => void): void;
  stream(s: MediaStream): void;
  started(a: Attempt): void;
  level(): number;
  release(a: Attempt): void;
  settle(a: Attempt, r: RecEnd): Promise<TapOut>;
}

/**
 * { text }：屏幕上出过的字（当场存、后台用录音补）；upload：一个字没出（有录音就存占位、后台上传）；done：这一次已经作废了，什么都不做；
 * { res }：按这个结果收尾、不上传（令牌回了今天用完、没同意：一句话不再为它上传整段录音）
 */
export type TapOut = 'done' | 'upload' | { text: string } | { res: VoiceResult };

export function createRecRoute(c: VoiceCore) {
  let kept: KeptAudio | null = null;
  /** 留着的录音是哪一条占位的（重试占位失败时）：提示条上再点“重试”照样撤那一条 */
  let keptPend: string | null = null;
  /** 这一次挂着的边录边转写（没有 = 只录音上传）；“重试”不挂 */
  let tap: RecTap | null = null;

  /** 先存、后台再换（voice-pending.ts） */
  const pend = createPending(c);
  /** 重试占位的这一次没走完（取消、作废）：占位照旧“没整理成” */
  const pendFail = (a: Attempt): void => {
    if (a.pend) void pend.settled(a.pend, 'failed');
  };

  /** 前台收尾（重试、令牌回了用完或没同意）：结果怎么映射是 finishVoice 的，这里只交前台自己的存法、提示和占位的去留。
   *  fresh：刚从服务器回来的（记剩余次数）；占位留着的旧结果不再记 */
  const handle = async (a: Attempt, res: VoiceResult, fresh = true): Promise<void> => {
    // 只有“AI 没回应”留着录音（可以重试）
    if (res.kind !== 'failed') kept = null;
    if (fresh) c.account(res);
    const p = a.pend ?? null;
    await finishVoice(res, c.d().ctx(), c.d().online(), {
      async save(plan, raw) {
        const out = await c.savePlan(a, plan, raw);
        if (p === null) return;
        // 出了确认行：等选完或关掉再定占位的去留
        if (out === 'ask') pend.confirming(p, res);
        else void pend.settled(p, c.savedOk(out) ? 'saved' : 'failed', res);
      },
      async ask(ask, raw) {
        c.askOut(a, ask, raw, 1);
        if (p !== null) void pend.settled(p, 'saved');
      },
      async none() {
        if (p !== null) void pend.settled(p, 'dropped');
        c.end(a);
        c.go({ type: 'no_speech' });
        c.show('no_speech');
      },
      async miss(f) {
        if (p !== null) void pend.settled(p, 'failed');
        c.end(a);
        if (f.do === 'idle') return c.toIdle();
        c.go(f.status === 'no_speech' ? { type: 'no_speech' } : { type: 'done', status: f.status });
        c.show(f.note);
      },
    });
  };

  /** 重试那一路：这段录音前台上传、等 AI 回来再收尾 */
  const upload = async (a: Attempt, clip: VoiceClip): Promise<void> => {
    const up = await toUpload(clip);
    if (!c.alive(a, 'to_upload')) return pendFail(a);
    kept = { blob: up.blob, mime: up.mime, keptAt: clock.now() };
    keptPend = a.pend ?? null;
    const res = await sendVoice(up, baseReqCtx(c.d().ctx()), c.d().callVoice, { online: c.d().online, signal: a.ac.signal });
    if (!c.alive(a, 'send')) return pendFail(a);
    await handle(a, res);
  };

  /** 松手先存没存上：录音留着，提示条“AI 没回应 · 重试”（重试上传这段录音）。存的那一步可能已经收掉了这一次（写库失败），所以不看 alive，只看没有更新的一次；
   *  没有录音（录音器停不下来）：savePlan 已经提示“没保存上” */
  const keepClip = async (a: Attempt, clip: VoiceClip | null): Promise<void> => {
    if (!clip) return;
    const up = await toUpload(clip);
    const now = c.current();
    if (now !== null && now !== a) return;
    kept = { blob: up.blob, mime: up.mime, keptAt: clock.now() };
    rlog(`voice rec keep bytes=${up.blob.size}`);
    c.end(a);
    if (c.view().status !== 'ai_failed') c.go({ type: 'done', status: 'ai_failed' });
    c.show('ai_failed');
  };

  /** 令牌回了今天用完（实时转写那边报的，这一次还录着或在收尾、还没开始写库）：当场收掉——停录、关麦克风（drop 中止录音器）、不上传、回到没按，
   *  再按同一份前台收尾记下用完、提示“语音暂时用不了 · 几点恢复”（下次按下直接挡） */
  const stopNow = (a: Attempt, res: VoiceResult): void => {
    if (c.current() !== a || a.committed) return;
    rlog(`voice rec stop_now why=${res.kind} status=${c.view().status}`);
    c.drop(`stop_${res.kind}`);
    c.toIdle();
    void handle(a, res);
  };

  /** 松手以后（录音器交了结局、实时转写交了已出的字）：先存、后台再换，只此一条。text 空 = 一个字没出（存占位）；t0 = 松手那一刻 */
  const release = async (a: Attempt, r: RecEnd, text: string, t0: number): Promise<void> => {
    if (!c.alive(a, 'rec_stop')) return;
    rlog(`voice rec end rec=${r.ok ? 'ok' : r.fail} bytes=${r.ok ? r.clip.blob.size : 0}`);
    const clip = r.ok ? r.clip : null;
    // 没出字、也没有录音：按原因提示
    if (text === '' && !clip) {
      c.end(a);
      c.toIdle();
      return c.show(recNote(r));
    }
    c.set({ live: '' });
    const d = c.d();
    // 语音不带选中的日子：先存和 AI 整理都按这一份，两边才比得上
    const ctx: TypeCtx = { ...d.ctx(), day: null };
    let plan: TypePlan;
    let path: SavePath;
    if (text === '') {
      plan = todayTodo(d.pend.title, clock.now());
      path = 'pending';
    } else {
      // 出了字：只按本机规则拆（不开 AI，不扣次数）；一条都拆不出也不当场等 AI，整句存成今天的一条待办
      const local = (await planText(text, ctx, { online: d.online, aiOn: false, call: d.callAi })).plan;
      if (!c.alive(a, 'live_plan')) return;
      const whole = local.items.length === 0 && !local.ask;
      plan = whole ? todayTodo(text, clock.now()) : local;
      path = whole ? 'whole' : 'text';
    }
    const m = await pend.saveNow(a, plan, text, t0, path, clip?.blob.size ?? 0);
    if (m === 'keep') return keepClip(a, clip);
    // 没有录音：只存字，不排后台整理
    if (m === 'done' || !clip) return;
    void pend.tidyLater(m, clip, ctx, t0, text === '');
  };

  /** 停录以后的收尾抛了错：记日志、能保住录音就保住、收掉这一次，提示“没保存上”，状态不卡在 uploading */
  const crashed = (a: Attempt, r: RecEnd | null, e: unknown): void => {
    rlog(`voice rec stop_err name=${e instanceof Error ? e.name : 'unknown'}`);
    const now = c.current();
    if (now !== null && now !== a) return;
    if (r?.ok) kept = { blob: r.clip.blob, mime: r.clip.mime, keptAt: clock.now() };
    c.end(a);
    if (!c.idle()) c.go({ type: 'done', status: 'ai_failed' });
    c.show('not_saved');
  };

  return {
    /** 开录音器（按住满 350 ms，或点“再说一次”）；withTap：挂上的边录边转写（Gemini 实时转写，voice-gemini.ts）；
     *  locked：“再说一次”，面板直接是锁定的样子（没有手指按着，点“记下”收尾） */
    async begin(withTap: RecTap | null = null, locked = false) {
      const a = c.begin();
      const t0 = clock.now();
      tap = withTap;
      c.set({ live: '' });
      c.go({ type: 'prepare' });
      if (locked) c.go({ type: 'lock' });
      withTap?.begin(a, (res) => stopNow(a, res));
      const r = await startRecorder({
        maxMs: AI_AUDIO_MAX_MS,
        maxBytes: AI_AUDIO_MAX_BYTES,
        bitsPerSecond: AI_AUDIO_BITS_PER_SECOND,
        signal: a.ac.signal,
        onAutoStop: () => {
          if (c.current() === a) c.finish();
        },
        ...(withTap ? { onStream: (s: MediaStream) => withTap.stream(s) } : {}),
      });
      if (!c.alive(a, 'rec_start')) {
        // 开起来之前就丢掉、松手了：录音器自己按取消收拾（signal）
        if (r.ok) void r.rec.stop();
        // 等 iOS 系统框点“允许”时手指已经松开（too_early），这一下作废了：提示再按住一次，不让人猜
        const waited = clock.now() - t0;
        if (r.ok && a.droppedBy === 'too_early' && waited >= MIC_PROMPT_MS && c.current() === null && c.view().status === 'idle' && c.view().card === null) {
          rlog(`voice mic_ready waited_ms=${Math.round(waited)}`);
          c.show('mic_ready');
        }
        return;
      }
      if (!r.ok) {
        // 录音器开不起来：挂着的边录边转写一起收拾（关音频上下文）
        void withTap?.settle(a, r);
        c.end(a);
        c.toIdle();
        if (r.fail === 'denied') c.go({ type: 'card', card: 'denied' });
        else c.show('rec_failed');
        return;
      }
      a.rec = r.rec;
      withTap?.started(a);
      c.go({ type: 'start' });
    },
    /** 松手、点“记下”、60 秒到了：停录、交给 release */
    stop() {
      const a = c.current();
      if (c.view().status !== 'recording' || !a) return;
      const rec = a.rec;
      if (!rec) return;
      // 面板收起，提示条“正在听你说的… · 取消”：停录这一步也能取消
      c.set({ secs: Math.max(1, Math.round((rec.elapsed()) / 1000)) });
      c.go({ type: 'stop' });
      const t = tap;
      const t0 = performance.now();
      // 挂着边录边转写：松手这一刻它就开始收尾（冻结采音、发结束、等定稿），和停录并行
      t?.release(a);
      let got: RecEnd | null = null;
      void rec
        .stop()
        .then(async (r) => {
          got = r;
          const out = t ? await t.settle(a, r) : 'upload';
          if (out === 'done') return;
          if (typeof out === 'object' && 'res' in out) {
            if (c.alive(a, 'gem_res')) await handle(a, out.res);
            return;
          }
          await release(a, r, out === 'upload' ? '' : out.text, t0);
        })
        .catch((e: unknown) => crashed(a, got, e));
    },
    /** “重试”：同一段录音再传一次 */
    retry() {
      // 连点第二下：已经在上传了
      if (c.view().status !== 'ai_failed') return;
      const k = kept;
      c.clearNote();
      if (!k || keptExpired(k, clock.now())) {
        kept = null;
        c.toIdle();
        return;
      }
      if (!c.d().online()) {
        c.show('net_down');
        return;
      }
      rlog(`voice retry bytes=${k.blob.size}`);
      tap = null;
      const a = c.begin();
      if (keptPend) a.pend = keptPend;
      c.go({ type: 'retry' });
      void upload(a, k);
    },
    pending: pend,
    /** 待办编辑页点占位的“重试”（voice-pending.ts）：AI 上次已经回来、没换成的直接拿那次的结果收尾（不再调 AI），
     *  否则用留着的录音前台上传（同提示条的“重试”，要问的照常出确认行）。正在录、正在整理时不接；录音没了（过期、别的设备存的）返回 gone */
    async retryPending(id: string): Promise<'started' | 'busy' | 'gone' | 'offline'> {
      if (c.current() !== null || !c.idle() || c.view().card !== null) return 'busy';
      const h = await pend.heldOf(id);
      if (!h) {
        rlog('voice pending retry gone');
        return 'gone';
      }
      if (!h.res && !c.d().online()) {
        c.show('offline');
        return 'offline';
      }
      rlog(`voice pending retry bytes=${h.clip.blob.size}${h.res ? ' res=1' : ''}`);
      tap = null;
      c.batch.fresh();
      c.closeNote();
      const a = c.begin();
      a.pend = id;
      pend.retrying(id);
      c.go({ type: 'retry' });
      if (h.res) void handle(a, h.res, false);
      else void upload(a, h.clip);
      return 'started';
    },
    forget() {
      kept = null;
      keptPend = null;
    },
    elapsed: () => c.current()?.rec?.elapsed() ?? 0,
    // 挂着边录边转写：用它量的真实电平（和录音器的音量计不同时开两个音频上下文）；它量不到（-1）才用录音器的
    level: () => {
      const l = tap?.level() ?? -1;
      return l >= 0 ? l : (c.current()?.rec?.level() ?? -1);
    },
  };
}
