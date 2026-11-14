// 查找面板、结果层开没开（B4b-2、B4b-3）：模块里一份，FindHost 订阅它画面板。n 每打开一次加 1，面板按它重新挂载（换了查询从头来）。纯 TS，很小
// • openFind(q, from)：打字条“看起来是要查找”回车、Ctrl+K
// • openAssist(a)：“＋”判成查找、总结、取消、改期、完成以后（打字、录音、quick-add），或提示条上的“改成搜索”“也帮你找了一下”（架构 5.14 第 2～4、7 点）。
//   内容类查找（没有时间范围）直接是查找面板，页脚多“改成记下”“总结一下”；时间类、总结、取消改期完成是结果层（ui/AssistPanel）
import type { AssistAsk } from '../../../../shared/logic/parse/assist.ts';

export type FindFrom = 'plus' | 'ctrlk' | 'voice' | 'quick' | 'notice';

/** 结果层要的（plus 那边给） */
export interface AssistReq {
  ask: AssistAsk;
  /** 原话（录音是转写）：“改成记下”用；从提示条打开的（已经存过了）为 '' */
  raw: string;
  /** 判断这一句已经花了几次 AI（总结再加 1，卡片写“这次用了 N 次 AI”） */
  aiUsed: 0 | 1;
  from: FindFrom;
  /** “改成记下”“都不是 · 按原话记下”：按记下保存原话（plus 给；已经存过了的为 null，不出这个按钮） */
  record: (() => Promise<void>) | null;
  /** 模糊时先存了的这一批：查找排除它们（0.23 L3）；在卡片里确认取消、改期、完成以后撤销它们（undoSaved） */
  exclude: readonly string[];
  undoSaved: (() => Promise<void>) | null;
  /** 关掉结果层（plus 清草稿） */
  onClose: (() => void) | null;
}

export interface FindOpen {
  q: string;
  from: FindFrom;
  n: number;
  assist: AssistReq | null;
}

let cur: FindOpen | null = null;
let seq = 0;
const subs = new Set<() => void>();
const emit = (): void => {
  for (const fn of [...subs]) fn();
};

export function openFind(q: string, from: FindFrom): void {
  seq += 1;
  cur = { q, from, n: seq, assist: null };
  emit();
}

export function openAssist(a: AssistReq): void {
  seq += 1;
  cur = { q: 'query' in a.ask ? a.ask.query.text : a.ask.target.text, from: a.from, n: seq, assist: a };
  emit();
}

/** 内容类查找（查找、没有时间范围）用查找面板，别的用结果层 */
export const usesFindPanel = (a: AssistAsk): boolean => a.intent === 'search' && a.query.range === null && a.query.text.trim() !== '';

export function closeFind(): void {
  if (cur === null) return;
  const was = cur;
  cur = null;
  emit();
  was.assist?.onClose?.();
}

export const findOpenSnapshot = (): FindOpen | null => cur;
export function subscribeFindOpen(fn: () => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
