// 新建永久失败、码不能重试时“未同步”提示条的两个按钮（R-378）：write.* 一族的入口，功能层只经这里，不直接碰 outbox（架构 4.1，M2）
// • copy = “另存为新的一条”（换新 id，合成一个 insert），drop = “放弃”（连同后面的项、依赖项一起删）；规则见 outbox-failed-create.ts
// • 单独成文件、不放进 write.ts：write.ts 在首屏块里；只有提示条里新建失败的那一段（按需下载）用它
// • 失败的映射同 write-gone.ts：没启动、本机库打不开、严格校验代码下载不下来 → local_unavailable；库正在关 → closing；
//   换账号、被移除、设了闸 → switching；真正的拒收（has_dependents、严格校验的码）→ rejected，带 code
// 纯 TS：不准 import React 和任何功能（A1）
import { getBoot } from './boot.ts';
import { resolveFailedCreateImpl, type FailedCreateReport } from './outbox-failed-create.ts';
import { OutboxRejectError } from './outbox-logic.ts';
import { outboxCtx } from './outbox.ts';
import { localWriteBlocker, writeFailOf, type WriteFailReason } from './write.ts';

export type ResolveFailedCreateResult =
  | ({ ok: true } & FailedCreateReport)
  | { ok: false; reason: WriteFailReason | 'rejected'; code?: string };

/** 处理一条新建失败的记录：copy 另存为新的一条，drop 放弃 */
export async function resolveFailedCreate(table: string, id: string, mode: 'copy' | 'drop'): Promise<ResolveFailedCreateResult> {
  const blocker = localWriteBlocker();
  const outbox = getBoot()?.outbox;
  const ctx = outbox ? outboxCtx.get(outbox) : undefined;
  if (blocker || !ctx) return { ok: false, reason: blocker ?? 'local_unavailable' };
  try {
    const r = await resolveFailedCreateImpl(ctx, table, id, mode, crypto.randomUUID());
    return { ok: true, ...r };
  } catch (e) {
    const reason = writeFailOf(e);
    if (reason) return { ok: false, reason };
    if (e instanceof OutboxRejectError) return { ok: false, reason: 'rejected', code: e.code };
    throw e;
  }
}
