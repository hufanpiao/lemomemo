// 正式的那一份录音控制器 + 把判成别的意图的一句交给结果层（B4b-3；架构 5.14 第 2～4、7 点）
// • mainVoice：原来在 useVoice.ts 模块里建，挪到这里，好让打字条、quick-add、结果层的“改成记下”都走它那一批（提示条、撤销同一套）
// • toAssist：判出来的那一刻先把原话写进本机草稿（assist，24 小时；被杀掉以后再点开“＋”填回），再打开 smart-search 的结果层；
//   “改成记下”= mainVoice.record（只按本机规则、不花 AI 次数，存好清草稿）；关掉结果层清草稿（主持人代定，写进推进计划第三节）
// • 运行日志：assist send intent= from= ai= len=（只记字数）
import type { AssistAsk } from '../../../../shared/logic/parse/assist.ts';
import { clock } from '../../../platform/clock.ts';
import { onQuickAddText } from '../../../platform/desktop.ts';
import { isTauri } from '../../../platform/env.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { loadFindOpen } from '../../smart-search/index.ts';
import { clearTypeDraft, writeTypeDraft } from '../data/type-draft.ts';
import { createVoiceSession } from '../data/voice-session.ts';

export type AssistFrom = 'plus' | 'voice' | 'quick' | 'notice';

export interface ToAssist {
  ask: AssistAsk;
  raw: string;
  aiUsed: 0 | 1;
  from: AssistFrom;
}

export const mainVoice = createVoiceSession({ onAsk: (ask, raw, aiUsed) => toAssist({ ask, raw, aiUsed, from: 'voice' }) });

/** 原话按记下存（结果层的“改成记下”、quick-add 判成记下的）：存好清草稿 */
export async function recordRaw(raw: string, from: string): Promise<void> {
  if (await mainVoice.record(raw, from)) await clearTypeDraft();
}

/**
 * exe 的全局快速记录框（quick-add 窗口）交上来的一句（架构 5.14 第 1 点；0.18 M2 那个窗口不连服务器，现在只有 Rust 转发、没有自己的判断）：
 * main 页走打字条同一套 planText（本机规则有把握就不调 AI），记下的进这一批（提示条同录音），判成别的意图的打开结果层。
 * 不是 exe 不订阅；返回取消订阅（RecordHost 卸载时）
 */
export function listenQuickAdd(): () => void {
  if (!isTauri()) return () => undefined;
  let off: (() => void) | null = null;
  let dead = false;
  void onQuickAddText((text) => {
    rlog(`quick submit len=${[...text].length}`);
    void mainVoice.record(text, 'quick', 'plan');
  }).then(
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

export function toAssist(o: ToAssist): void {
  rlog(`assist send intent=${o.ask.intent} from=${o.from} ai=${o.aiUsed} len=${[...o.raw].length}`);
  const hasRaw = o.raw.trim() !== '';
  if (hasRaw) void writeTypeDraft({ text: o.raw, day: null, assist: true }, clock.now());
  void loadFindOpen().then((m) =>
    m.openAssist({
      ask: o.ask, raw: o.raw, aiUsed: o.aiUsed, from: o.from, exclude: [], undoSaved: null,
      record: hasRaw ? () => recordRaw(o.raw, 'assist') : null,
      onClose: hasRaw ? () => void clearTypeDraft() : null,
    }),
  );
}
