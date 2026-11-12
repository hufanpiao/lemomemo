// 按住“＋”的手势接到录音控制器上（B3 FA-3；FA-3 整块评审第 3、9 条）
// • hold：data/hold-input.ts 的那一份对界面层转出（A1：界面层不直接引 data）；ui/TypeBar.tsx 再转给 app/plus-slot.tsx，
//   跟打字条同一块下载（这个文件只带 react 和手势判定，录音器、手机识别、面板留在 RecordHost 那一块按需加载）
// • useVoiceSink：录音那一套挂上以后接手手势（setHoldSink），卸载时交还；取消区、锁定区由面板量好的两个 ref 判
import { useEffect, type RefObject } from 'react';
import { rlog } from '../../../platform/run-log-api.ts';
import { hold, setHoldSink } from '../data/hold-input.ts';
import type { VoiceSession } from '../data/voice-session.ts';

export { hold };

const inside = (el: HTMLElement | null, x: number, y: number): boolean => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
};

export function useVoiceSink(s: VoiceSession, cancelZone: RefObject<HTMLElement | null>, lockZone: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    setHoldSink({
      down: () => s.down(),
      start: () => s.start(),
      zoneAt: (x, y) => (inside(cancelZone.current, x, y) ? 'cancel' : inside(lockZone.current, x, y) ? 'lock' : null),
      zone: (z) => s.zone(z),
      lock: () => s.lock(),
      finish: () => s.finish(),
      discard: () => s.discard('hold'),
      idle: () => s.idle(),
    });
    // 录音那一套挂上了（之后按住才有人接手）：真机日志里按下时没有“voice hold start”，先看这一行出没出
    rlog('voice host ready');
    return () => {
      setHoldSink(null);
      hold.reset();
    };
  }, [s, cancelZone, lockZone]);
}
