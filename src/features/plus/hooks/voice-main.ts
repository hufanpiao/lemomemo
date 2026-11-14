// 正式的那一份录音控制器（B4b-3；架构 5.14 第 1、2 点）
// • mainVoice：原来在 useVoice.ts 模块里建，挪到这里，好让结果层的“改成记下”（assist-open.ts 按需 import）、quick-add 都走它那一批（提示条、撤销同一套）
// • 判成别的意图的交给 assist-open.ts 的 toAssist（录音、quick-add 的日历日子是 null：控制器的上下文不带选中的那天）
// • quick-add：exe 的全局快速记录框交来的一句；控制器正忙（正在录、正在整理）接不了时把原话留作草稿，下次点开“＋”填回，不丢
// • 运行日志：quick submit len=（只记字数）、quick record out=
import { clock } from '../../../platform/clock.ts';
import { isTauri } from '../../../platform/env.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { writeAssistDraft } from '../data/type-draft.ts';
import { createVoiceSession } from '../data/voice-session.ts';
import type { ToAssist } from './assist-open.ts';

/** 结果层出口按需下载（assist-open.ts 不进打字条、录音那几块的静态依赖：首屏主包的预加载表少一项，B5 首屏净增额度） */
const toAssist = (o: ToAssist): void => void import('./assist-open.ts').then((m) => m.toAssist(o));

export const mainVoice = createVoiceSession({ onAsk: (ask, raw, aiUsed, from) => toAssist({ ask, raw, aiUsed, from: from === 'quick' ? 'quick' : 'voice', day: null }) });

/**
 * exe 的全局快速记录框（quick-add 窗口）交上来的一句（架构 5.14 第 1 点；0.18 M2 那个窗口不连服务器，现在只有 Rust 转发、没有自己的判断）：
 * main 页走打字条同一套 planText（本机规则有把握就不调 AI），记下的进这一批（提示条同录音），判成别的意图的打开结果层。
 * 不是 exe 不订阅；返回取消订阅（RecordHost 卸载时）
 */
export function listenQuickAdd(): () => void {
  if (!isTauri()) return () => undefined;
  let off: (() => void) | null = null;
  let dead = false;
  // desktop.ts 只有 exe 用得上：按需 import，不进录音这一块的静态依赖（首屏主包的预加载表少一项）
  void import('../../../platform/desktop.ts').then((m) => m.onQuickAddText((text) => {
    rlog(`quick submit len=${[...text].length}`);
    void mainVoice.record(text, 'quick', 'plan').then((out) => {
      rlog(`quick record out=${out}`);
      if (out !== 'saved') void writeAssistDraft({ text, day: null }, clock.now(), false);
    });
  })).then(
    (f) => {
      if (dead) f();
      else off = f;
    },
    () => rlog('quick listen failed'),
  );
  return () => {
    dead = true;
    off?.();
  };
}
