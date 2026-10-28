// 记录类型（0.27 第 2 点）：以各功能清单的 recordKinds 为准。
// 为了让 TS 拿到字面量类型，这里另写一份 as const 的名单，加载时和清单汇总的结果逐项比对，对不上直接抛错（单元测试和 D1 都会加载它）
// ai.ts 的 kind 枚举、“＋”结果行渲染器的 kind 类型都用这里的；加一种记录：先改清单，再改下面对应的一行
import { z } from 'zod';
import { allManifests } from '../manifests/index.ts';

export const AI_KINDS = ['event', 'todo', 'note', 'anniv'] as const;                 // AI 能识别出来的（打字整理、录音）
export const INTENT_KINDS = ['event', 'todo', 'note', 'anniv'] as const;             // “＋”的意图里能出现的
export const RESULT_KINDS = ['event', 'todo', 'note', 'image', 'file', 'anniv'] as const;   // “＋”查找结果里显示的
export const VECTOR_KINDS = ['event', 'todo', 'note', 'image', 'file'] as const;     // 进按意思查找的（= note_vectors、embed_queue 的 check）

const kinds = allManifests.flatMap((m) => m.recordKinds);
function same(name: string, mine: readonly string[], fromManifest: string[]): void {
  const a = [...mine].sort().join(','), b = [...fromManifest].sort().join(',');
  if (a !== b) throw new Error(`kinds_drift:${name}:${a}≠${b}`);
}
same('AI_KINDS', AI_KINDS, kinds.filter((k) => k.ai.parse).map((k) => k.kind));
same('INTENT_KINDS', INTENT_KINDS, kinds.filter((k) => k.ai.intent).map((k) => k.kind));
same('RESULT_KINDS', RESULT_KINDS, kinds.filter((k) => k.plusResult).map((k) => k.kind));
same('VECTOR_KINDS', VECTOR_KINDS, kinds.filter((k) => k.vector !== null).map((k) => k.kind));

export const aiKind = z.enum(AI_KINDS);
export const intentKind = z.enum(INTENT_KINDS);
export const resultKind = z.enum(RESULT_KINDS);
export const vectorKind = z.enum(VECTOR_KINDS);

export type AiKind = z.infer<typeof aiKind>;
export type IntentKind = z.infer<typeof intentKind>;
export type ResultKind = z.infer<typeof resultKind>;
export type VectorKind = z.infer<typeof vectorKind>;

/** kind → 管它的功能开关（app_config.features 的键）；AI 输出按 featureOn 过滤时用 */
export const KIND_FLAG: Readonly<Record<string, string>> = Object.fromEntries(kinds.map((k) => [k.kind, k.flag]));
/** kind → 表 */
export const KIND_TABLE: Readonly<Record<string, string>> = Object.fromEntries(kinds.map((k) => [k.kind, k.table]));
