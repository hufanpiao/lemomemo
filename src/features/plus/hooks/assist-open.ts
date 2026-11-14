// 把判成别的意图的一句交给结果层（B4b-3；架构 5.14 第 2～4、7 点）：打字条、录音、quick-add、提示条的“改成搜索”共用这一个出口
// • 判出来的那一刻先把原话写进本机草稿（assist，24 小时；被杀掉以后再点开“＋”填回），再打开 smart-search 的结果层
//   录音、quick-add 交来的：用户在打字条里收起的字还在草稿里时不覆盖（只有一份草稿）
// • “改成记下”= 录音控制器 mainVoice.record（只按本机规则、不花 AI 次数，进录音那一批：提示条、撤销同一套）；
//   控制器在 voice-main.ts，这里按需 import：打字条那一块不带上整个录音控制器（首屏预加载表、分包）
// • 草稿：存好了才清；关掉结果层时“改成记下”还没存好（正在存、控制器正忙、没存上）就留着，下次点开“＋”填回，原话不丢
// • 运行日志：assist send intent= from= ai= len=（只记字数）、assist record out=
import type { AssistAsk } from '../../../../shared/logic/parse/assist.ts';
import type { DateStr } from '../../../../shared/core/date.ts';
import { clock } from '../../../platform/clock.ts';
import { rlog } from '../../../platform/run-log-api.ts';
import { loadFindOpen } from '../../smart-search/index.ts';
import { clearAssistDraft, writeAssistDraft } from '../data/type-draft.ts';

export type AssistFrom = 'plus' | 'voice' | 'quick' | 'notice';

export interface ToAssist {
  ask: AssistAsk;
  raw: string;
  aiUsed: 0 | 1;
  from: AssistFrom;
  /** 日历页选中的那天（“改成记下”记到这天，草稿也带上）；别的页 null */
  day: DateStr | null;
}

/** 原话按记下存（结果层的“改成记下”）：存好才清草稿；返回存没存上 */
export async function recordRaw(raw: string, day: DateStr | null): Promise<boolean> {
  const { mainVoice } = await import('./voice-main.ts');
  const out = await mainVoice.record(raw, 'assist', 'local', day);
  rlog(`assist record out=${out}`);
  if (out !== 'saved') return false;
  await clearAssistDraft();
  return true;
}

export function toAssist(o: ToAssist): void {
  rlog(`assist send intent=${o.ask.intent} from=${o.from} ai=${o.aiUsed} len=${[...o.raw].length}`);
  const hasRaw = o.raw.trim() !== '';
  // 打字条交来的：输入条里的字就是这一句，照写；别的来路不盖掉用户收起的草稿
  if (hasRaw) void writeAssistDraft({ text: o.raw, day: o.day }, clock.now(), o.from === 'plus');
  let recording: Promise<boolean> | null = null;
  void loadFindOpen().then((m) =>
    m.openAssist({
      ask: o.ask, raw: o.raw, aiUsed: o.aiUsed, from: o.from, exclude: [], undoSaved: null,
      record: hasRaw ? () => (recording = recordRaw(o.raw, o.day)) : null,
      // 没点“改成记下”就关：原话不要了，清草稿；点了的由 recordRaw 存好再清
      onClose: hasRaw ? () => void (recording === null ? clearAssistDraft() : undefined) : null,
    }),
  );
}
