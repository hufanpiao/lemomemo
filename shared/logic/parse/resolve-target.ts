// “＋”取消、改期、完成的 target 规整（架构 5.14 第 7 点）：本机规则和 AI 输出过完 schema 后都走这一个函数。
// 不变量：只有改期能带 all；改期批量 =（原话有“都”类词，或说的是泛指词 / 空、没说时刻）并且有日子或 with_overdue；
// 取消、完成一律去掉 all，带 all 又说的是泛指词时 bulkRefused（卡片请用户去列表里操作）。不改输入、不改别的字段，结果再跑一遍不变。
import { isGenericText } from './generic-words.ts';

/** 带 target 的三种意图（取值是 intent.ts 的 PLUS_INTENTS 的一部分） */
export type TargetIntent = 'cancel' | 'reschedule' | 'complete';
export type TargetKind = 'event' | 'todo';

/** 指的是哪件事（B4b-3 给 shared/schema/ai.ts 加 zod 时和它对齐） */
export interface PlusTarget {
  text: string;
  date: string | null;
  time: string | null;
  kinds: TargetKind[];
  with_overdue?: boolean;
  all?: boolean;
}

export interface ResolvedTarget {
  target: PlusTarget;
  /** 取消、完成说的是“都 + 泛指词”：不列候选，卡片写“请在列表里操作” */
  bulkRefused: boolean;
}

export function resolveTarget(intent: TargetIntent, input: PlusTarget): ResolvedTarget {
  const { all, ...rest } = input;
  const target: PlusTarget = { ...rest, kinds: [...input.kinds] };
  const generic = isGenericText(input.text);
  if (intent !== 'reschedule') return { target, bulkRefused: all === true && generic };
  const scoped = input.with_overdue === true || input.date !== null;
  if (scoped && (all === true || (generic && input.time === null))) target.all = true;
  return { target, bulkRefused: false };
}
