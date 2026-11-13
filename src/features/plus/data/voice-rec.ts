// 按住“＋”的录音这一路（B3 任务单 FA-3；第二轮复查项从 voice-session.ts 拆出）：开录音器、停录、上传 ai-voice、结果收尾、留着的录音“重试”、网络慢计数
// • 松手（或点“记下”）面板就收起，进“上传中”：停录那一步也能在提示条上取消（录音器停不下来时最多等 REC_STOP_WAIT_MS）
// • AI 没回应：录音留在内存（最多 2 分钟）可以“重试”（同一段），或“再说一次”（改用手机自带识别，voice-speech.ts）
// • 网络原因失败的计数（net）跟着控制器那一份：“10 分钟内 2 次”要跨挂载算（FA-3 复查第 1 条；控制器不随 RecordHost 卸载）
// 纯 TS：不准 import React（A1）
import { AI_AUDIO_BITS_PER_SECOND, AI_AUDIO_MAX_BYTES } from '../../../../shared/schema/ai.ts';
import { clock } from '../../../platform/clock.ts';
import { startRecorder } from '../../../platform/recorder.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { rememberQuotaLeft } from './quota.ts';
import { NET_OK, REC_MAX_MS, isNetFail, keptExpired, netFailed, speechByNet, type KeptAudio, type NetFallback } from './record-logic.ts';
import { baseReqCtx } from './type-flow.ts';
import { sendVoice, toUpload, voiceFinal, type VoiceClip, type VoiceResult } from './voice-flow.ts';
import type { Attempt, VoiceCore } from './voice-session.ts';

/** 开录音器等了这么久还没开起来，当作中间弹过 iOS 系统麦克风框（R-417：主屏幕版每次启动第一次按都弹；不弹时约 0.7 秒） */
export const MIC_PROMPT_MS = 1500;

export function createRecRoute(c: VoiceCore) {
  let kept: KeptAudio | null = null;
  /** 10 分钟内网络原因失败几次 */
  let net: NetFallback = NET_OK;

  const handle = async (a: Attempt, res: VoiceResult): Promise<void> => {
    const now = clock.now();
    // 只有“AI 没回应”留着录音（可以重试）；网络原因的失败记一笔（10 分钟两次改用手机识别）
    if (res.kind !== 'failed') kept = null;
    else if (res.fail !== null && isNetFail(res.fail)) {
      net = netFailed(net, now);
      if (speechByNet(net, now)) rlog('voice net_slow speech_on');
    }
    if (res.kind === 'record') void rememberQuotaLeft(res.quotaLeft, now);
    if (res.kind === 'quota_out') {
      c.markQuotaOut();
      void rememberQuotaLeft(0, now);
    }
    const f = voiceFinal(res, c.d().ctx(), c.d().online());
    if (f.do === 'save') return c.savePlan(a, f.plan, f.raw);
    c.end(a);
    if (f.do === 'idle') return c.toIdle();
    c.go(f.status === 'no_speech' ? { type: 'no_speech' } : { type: 'done', status: f.status });
    c.show(f.note);
  };

  const upload = async (a: Attempt, clip: VoiceClip): Promise<void> => {
    const up = await toUpload(clip);
    if (!c.alive(a, 'to_upload')) return;
    kept = { blob: up.blob, mime: up.mime, keptAt: clock.now() };
    const res = await sendVoice(up, baseReqCtx(c.d().ctx()), c.d().callVoice, { online: c.d().online, signal: a.ac.signal });
    if (!c.alive(a, 'send')) return;
    await handle(a, res);
  };

  return {
    /** 开录音器（按住满 350 ms） */
    async begin() {
      const a = c.begin();
      const t0 = clock.now();
      c.set({ path: 'rec', why: null });
      c.go({ type: 'prepare' });
      const r = await startRecorder({
        maxMs: REC_MAX_MS,
        maxBytes: AI_AUDIO_MAX_BYTES,
        bitsPerSecond: AI_AUDIO_BITS_PER_SECOND,
        signal: a.ac.signal,
        onAutoStop: () => {
          if (c.current() === a) c.finish();
        },
      });
      if (!c.alive(a, 'rec_start')) {
        // 开起来之前就丢掉、松手了：录音器自己按取消收拾（signal）
        if (r.ok) void r.rec.stop();
        // R-417：等 iOS 系统框点“允许”时手指已经松开（too_early），这一下作废了：提示再按住一次，不让人猜
        const waited = clock.now() - t0;
        if (r.ok && a.droppedBy === 'too_early' && waited >= MIC_PROMPT_MS && c.current() === null && c.view().status === 'idle' && c.view().card === null) {
          rlog(`voice mic_ready waited_ms=${Math.round(waited)}`);
          c.show('mic_ready');
        }
        return;
      }
      if (!r.ok) {
        c.end(a);
        c.toIdle();
        if (r.fail === 'denied') c.go({ type: 'card', card: 'denied' });
        else c.show('rec_failed');
        return;
      }
      a.rec = r.rec;
      c.go({ type: 'start', path: 'rec' });
    },
    /** 松手、点“记下”、60 秒到了：停录、上传 */
    stop() {
      const a = c.current();
      const rec = a?.rec;
      if (c.view().status !== 'recording' || !a || !rec) return;
      // 面板收起，提示条“正在听你说的… · 取消”：停录这一步也能取消
      c.set({ secs: Math.max(1, Math.round(rec.elapsed() / 1000)) });
      c.go({ type: 'stop' });
      void rec.stop().then((r) => {
        if (!c.alive(a, 'rec_stop')) return;
        if (!r.ok) {
          c.end(a);
          c.toIdle();
          c.show(r.fail === 'empty' ? 'no_speech' : r.fail === 'stop_timeout' ? 'not_heard' : 'rec_failed');
          return;
        }
        void upload(a, r.clip);
      });
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
      const a = c.begin();
      c.go({ type: 'retry' });
      void upload(a, k);
    },
    forget() {
      kept = null;
    },
    net: () => net,
    elapsed: () => c.current()?.rec?.elapsed() ?? 0,
    level: () => c.current()?.rec?.level() ?? -1,
  };
}
