// 调 ai-memory（“记住的事”；契约 shared/schema/ai-memory.ts）：看、删、撤销、全部清空。
// 回包按 zod 认，认不出、断网、超时一律算失败（null / false），界面照失败提示，不当成已删。
// 纯 TS：不准 import React
import { AI_MEMORY_FN, memoryDoneRes, memoryListRes, type MemoryListRes, type MemoryReq } from '../../../../shared/schema/ai-memory.ts';
import { callFn, defaultFnDeps, type FnDeps } from '../../../platform/fn-call.ts';

export const MEMORY_TIMEOUT_MS = 10_000;

async function call(req: MemoryReq, signal: AbortSignal, d: FnDeps): Promise<unknown> {
  const r = await callFn(AI_MEMORY_FN, req, signal, MEMORY_TIMEOUT_MS, d);
  return r.ok && r.status >= 200 && r.status < 300 ? r.body : null;
}

/** 读一页；cursor 是上一页回的 next */
export async function listMemories(signal: AbortSignal, cursor: string | null = null, d: FnDeps = defaultFnDeps()): Promise<MemoryListRes | null> {
  const p = memoryListRes.safeParse(await call(cursor === null ? { action: 'list' } : { action: 'list', cursor }, signal, d));
  return p.success ? p.data : null;
}

/** 删一条、撤销、全部清空：服务器说成了才算 */
export async function changeMemory(req: Exclude<MemoryReq, { action: 'list' }>, signal: AbortSignal, d: FnDeps = defaultFnDeps()): Promise<boolean> {
  const p = memoryDoneRes.safeParse(await call(req, signal, d));
  return p.success && p.data.ok;
}
