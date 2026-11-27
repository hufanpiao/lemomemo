// 按住说话提问（方案页输入条右边的麦克风、“问点什么，或者按住说”）：按住开录，松手转成文字，交给 onText 当这一句发出去。
// • 录音器用 platform/recorder.ts（和“＋”同一份）；转写走 ai-voice 的只转写分支（data/voice-ask.ts，用途 stt、同一个额度门）
// • 按得太短（不到 shared/logic/gesture.ts 的 PRESS_HOLD_MS，和“＋”同一个数）不上传，提示“按住说话”；松手前录音器还没开起来的（等系统麦克风授权）这一下作废，授权后再按
// • 卸载（关抽屉）时取消：录音器按 signal 收拾、关麦克风，转写中的请求断开，转出来的字不再发
// • 运行日志只记状态、字节、字数、毫秒，不记内容
import { useCallback, useEffect, useRef, useState } from 'react';
import { PRESS_HOLD_MS } from '../../../../shared/logic/gesture.ts';
import { AI_AUDIO_BITS_PER_SECOND, AI_AUDIO_MAX_BYTES, AI_AUDIO_MAX_MS } from '../../../../shared/schema/ai.ts';
import { currentTz } from '../../../core/current-tz.ts';
import { clock } from '../../../platform/clock.ts';
import { thisDeviceKind } from '../../../platform/device-kind.ts';
import { recorderSupported, startRecorder, type ActiveRecorder } from '../../../platform/recorder.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { askTranscript } from '../data/voice-ask.ts';


export type VoicePhase = 'idle' | 'rec' | 'send';
export type VoiceHint = 'short' | 'denied' | 'none' | 'failed' | 'quota' | 'consent';

export function useChatVoice(locale: string, onText: (text: string) => void) {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [hint, setHint] = useState<VoiceHint | null>(null);
  const ac = useRef<AbortController | null>(null);
  const rec = useRef<ActiveRecorder | null>(null);
  const held = useRef(false);
  const textFn = useRef(onText);
  textFn.current = onText;

  useEffect(() => () => {
    ac.current?.abort();
    ac.current = null;
  }, []);

  const finish = useCallback(async (mine: AbortController, r: ActiveRecorder): Promise<void> => {
    const short = r.elapsed() < PRESS_HOLD_MS;   // 按住不到“＋”判按住的那个时长算没说
    rec.current = null;   // 先清：停录要等一会儿，这期间再松一次键不能把同一段录音传两遍
    const end = await r.stop();
    if (ac.current !== mine) return;
    rlog(`chat voice end rec=${end.ok ? 'ok' : end.fail} bytes=${end.ok ? end.clip.blob.size : 0} short=${short ? 1 : 0}`);
    if (short || !end.ok) {
      ac.current = null;
      setPhase('idle');
      setHint(short ? 'short' : 'failed');
      return;
    }
    setPhase('send');
    const t0 = clock.now();
    const res = await askTranscript({ blob: end.clip.blob, mime: end.clip.mime, now: clock.now(), tz: currentTz(), locale }, mine.signal);
    if (ac.current !== mine) return;
    ac.current = null;
    setPhase('idle');
    rlog(`chat voice stt ${res.ok ? `chars=${[...res.text].length}` : `fail=${res.reason}`} ms=${clock.now() - t0}`);
    if (!res.ok) return setHint(res.reason);
    if (res.text === '') return setHint('none');
    textFn.current(res.text);
  }, [locale]);

  const down = useCallback((): void => {
    if (ac.current !== null) return;
    const mine = new AbortController();
    ac.current = mine;
    held.current = true;
    setHint(null);
    setPhase('rec');
    rlog('chat voice start');
    void startRecorder({
      maxMs: AI_AUDIO_MAX_MS, maxBytes: AI_AUDIO_MAX_BYTES, bitsPerSecond: AI_AUDIO_BITS_PER_SECOND, signal: mine.signal,
      onAutoStop: () => {
        const r = rec.current;
        if (r && ac.current === mine) void finish(mine, r);
      },
    }).then((s) => {
      if (ac.current !== mine) {
        if (s.ok) void s.rec.stop();
        return;
      }
      if (!s.ok) {
        rlog(`chat voice start_failed why=${s.fail}`);
        ac.current = null;
        setPhase('idle');
        setHint(s.fail === 'denied' ? 'denied' : 'failed');
        return;
      }
      // 开起来之前手指已经松开（多半在等系统授权框）：这一下作废
      if (!held.current) {
        ac.current = null;
        void s.rec.stop();
        setPhase('idle');
        setHint('short');
        return;
      }
      rec.current = s.rec;
    });
  }, [finish]);

  const up = useCallback((): void => {
    held.current = false;
    const mine = ac.current;
    const r = rec.current;
    if (mine && r) void finish(mine, r);
  }, [finish]);

  /** 手势被系统收走（来电、滚动接管）：这一段不要了 */
  const cancel = useCallback((): void => {
    held.current = false;
    if (rec.current === null && ac.current === null) return;
    rlog('chat voice cancel');
    ac.current?.abort();
    ac.current = null;
    rec.current = null;
    setPhase('idle');
  }, []);

  // 只在手机上给（网页版、电脑版不做语音，右边换成发送钮）；“手机还是电脑”和按设备记的设置同一个判断
  return { phase, hint, down, up, cancel, supported: recorderSupported() && thisDeviceKind() === 'mobile' };
}
