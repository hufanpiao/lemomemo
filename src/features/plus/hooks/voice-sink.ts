// 按住“＋”的手势接到录音控制器上（B3 FA-3；FA-3 整块评审第 3、9 条）
// • hold：模块级的那一份在这里建（data/hold-input.ts 的 createHoldInput，注入 motion 的 swallowNextClick：进了录音以后松手，
//   随后补在“＋”上的那一下 click 吞掉；data 层不能引 motion），对界面层转出（A1：界面层不直接引 data）；ui/TypeBar.tsx 再转给 app/plus-slot.tsx，
//   跟打字条同一块下载（这个文件只带 react 和手势判定，录音器、手机识别、面板留在 RecordHost 那一块按需加载）
// • useVoiceSink：录音那一套挂上以后接手手势（setHoldSink），卸载时交还；取消区、锁定区由面板量好的两个 ref 判
// • 控制器不碰手势（FA-3 第二轮复查项，原来 6 处直接调 hold.reset()）：这里订阅着，录完（capturing 由 true 变 false：松手、点“记下 / 取消”、
//   60 秒到了、出错）就把手势收回没按的状态；锁定被拦下（没在录，比如出了“没网”提示、说明卡）也收回，不然“＋”一直按不下去
import { useEffect, type RefObject } from 'react';
import { swallowNextClick } from '../../../motion/index.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { createHoldInput, type HoldSink } from '../data/hold-input.ts';
import type { VoiceSession } from '../data/voice-session.ts';

let sinkNow: HoldSink | null = null;

/** 转给 GlassBar 的四个口子：ui/TypeBar.tsx 转出去，app/plus-slot.tsx 接到转发桥上。
 *  录音那一套（ui/RecordHost.tsx，按需加载）挂上以后用 setHoldSink 接手；没接手之前按住只当点一下 */
export const hold = createHoldInput(
  () => sinkNow,
  (el) => void swallowNextClick({ within: el }),
);

function setHoldSink(s: HoldSink | null): void {
  sinkNow = s;
}

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
      lock: () => {
        s.lock();
        if (!s.view().locked) hold.reset();
      },
      finish: () => s.finish(),
      discard: () => s.discard('hold'),
      idle: () => s.idle(),
    });
    // 录音那一套挂上了（之后按住才有人接手）：真机日志里按下时没有“voice hold start”，先看这一行出没出
    rlog('voice host ready');
    let was = s.view().capturing;
    const off = s.subscribe(() => {
      const now = s.view().capturing;
      if (was && !now) hold.reset();
      was = now;
    });
    return () => {
      off();
      setHoldSink(null);
      hold.reset();
    };
  }, [s, cancelZone, lockZone]);
}
