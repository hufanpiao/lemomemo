// “＋”判出来不是记下时交给结果层的那一份（架构 5.14 第 2～4、7 点；B4b-3）：本机规则 localIntent 和 AI 的意图输出都收成 AssistAsk。
// • 查找、总结：带 query；取消、改期、完成：带 target、to，target 一律再过 resolveTarget（本机和 AI 走同一个函数，批量判定、bulkRefused）
// • relatedTodos（取消时原话说了“相关待办”，卡片加一句“相关的待办请在列表里删”）按原话判，AI 输出不加字段（R-199）
// • 隐私记页面（scope vault）不做取消、改期、完成：这里不管，调用方本来就不在隐私记里走这一路
// 纯函数：不读时钟、不写日志
import type { PlusQuery, PlusTo, QueryIntent } from '../../schema/intent.ts';
import type { LocalIntent } from './intent.ts';
import { resolveTarget, type PlusTarget, type TargetIntent } from './resolve-target.ts';
import { RELATED_RE } from './target-parse.ts';
import { prepare } from './text.ts';

export type AssistAsk =
  | { intent: QueryIntent; query: PlusQuery }
  | { intent: TargetIntent; target: PlusTarget; to: PlusTo | null; bulkRefused: boolean; relatedTodos: boolean };

/** 本机规则判出来的（记下返回 null；取消、改期、完成已经过 resolveTarget） */
export function askOfLocal(li: LocalIntent): AssistAsk | null {
  if (li.intent === 'record') return null;
  if (li.intent === 'search' || li.intent === 'summarize') return li.query ? { intent: li.intent, query: li.query } : null;
  if (!li.target) return null;
  return { intent: li.intent, target: li.target, to: li.to, bulkRefused: li.bulkRefused, relatedTodos: li.relatedTodos };
}

/** zod 推出来的可选字段带 undefined（exactOptionalPropertyTypes）：进来先收成 PlusTarget */
type LooseTarget = Omit<PlusTarget, 'with_overdue' | 'all'> & { with_overdue?: boolean | undefined; all?: boolean | undefined };

/** AI 给的取消、改期、完成：过 resolveTarget，“相关待办”按原话判 */
export function askOfTarget(intent: TargetIntent, target: LooseTarget, to: PlusTo | null, raw: string): AssistAsk {
  const { with_overdue, all, ...rest } = target;
  const t: PlusTarget = { ...rest, ...(with_overdue === undefined ? {} : { with_overdue }), ...(all === undefined ? {} : { all }) };
  const r = resolveTarget(intent, t);
  return { intent, target: r.target, to: intent === 'reschedule' ? to : null, bulkRefused: r.bulkRefused, relatedTodos: intent === 'cancel' && RELATED_RE.test(prepare(raw)) };
}

/** 一次查找的关键词（结果层“改成搜索”、提示条“也帮你找了一下”用）：查找、总结用 query.text，取消、改期、完成用 target.text */
export function askText(a: AssistAsk): string {
  return 'query' in a ? a.query.text : a.target.text;
}
