// 写入入口 write.*（架构 4.1“写入只能经 write.*（入队）”；接手清单 K6-ver-new）：data 层和各功能只经这里写，不直接碰 outbox
// • 正常：校验 → 同一个事务里改 view、入队（core/outbox.ts 的 enqueue）→ 通知集合；返回 { ok: true, item }
//   item 为 null 只有一种情况：insert 后又撤销，和前面没发的一项抵消了（正常，等于已保存）
// • 没写进去不抛错，返回 { ok: false, reason }（K6-ver-new 复审 W1：不能和“抵消”混成一个 null，否则写入被静默丢掉）：
//   - local_unavailable：没启动，或本机库打不开（cache === null：unavailable、version_too_new）
//   - closing：本机库正在关（别的标签页在升级库，onversionchange；途中抛 CacheClosedError）
//   - switching：换账号、被移除、被停用或注销冷静期、退出登录途中（已封存或队列设了闸；途中抛 CacheClosedError / outbox_suspended）。
//     这几种情况页面都会马上清本机、跳走（app/sync-wiring.ts、core/account.ts），不会停在原页静默丢写入
// • 调用方义务：ok 为 false 时界面提示“没保存上”，并保留用户的输入（输入框不清空、弹窗不关）；
//   switching 例外——页面马上要重新载入或回登录页，不提示、不保留
// • unavailable 模式下“联网直写”归谁（K8 还是 write.*）待定，见接手清单 K6-write-online；在定之前 write.* 只报 local_unavailable
// • 读：组件经 core/store 的集合读（useCollection）；本机库打不开时集合是空的，读到空列表，不抛错
// • 校验不过、只读行等真正的拒收照样抛 OutboxRejectError（调用方提示）
// • settings 的 ai.enabled、ai.vault（架构 0.41 第 2 条）：不准软删、不准撤销，ai.vault 只能写 false；违反时抛 OutboxRejectError，码同服务器
//   settings_guard（vault_required / settings_key_immutable），不入队。这两个键请用 core/ai-settings.ts 的 writeAiSwitch 写
// 放在 core/write.ts 而不是 core/store.ts：要读 boot.ts 的 getBoot，而 boot.ts 已经 import store.ts（避免循环引用）
// 纯 TS：不准 import React 和任何功能（A1）
import { getBoot } from './boot.ts';
import { CacheClosedError } from './cache.ts';
import { OutboxRejectError, type EnqueueInput, type OutboxItem, type RecRef } from './outbox.ts';
import { collection, type Row } from './store.ts';

export interface WriteOptions {
  /** 带提醒（调用方用 shared 的 remindAtOf 本机现算） */
  remind?: boolean;
  /** 依赖的记录（note_images → notes 等） */
  deps?: readonly RecRef[];
}

/** 没写进去的原因（见文件头） */
export type WriteFailReason = 'local_unavailable' | 'closing' | 'switching';

export type WriteResult = { ok: true; item: OutboxItem | null } | { ok: false; reason: WriteFailReason };

/** 现在写不进本机的原因；能写时返回 null */
export function localWriteBlocker(): WriteFailReason | null {
  const boot = getBoot();
  const cache = boot?.cache;
  const outbox = boot?.outbox;
  if (!boot || !cache || !outbox) return 'local_unavailable';
  if (boot.switching || cache.isSealed() || outbox.isSuspended()) return 'switching';
  if (cache.isClosed()) return 'closing';
  return null;
}

/** 现在能不能写进本机 */
export function canWriteLocal(): boolean {
  return localWriteBlocker() === null;
}

async function enqueue(input: EnqueueInput): Promise<WriteResult> {
  const blocker = localWriteBlocker();
  const outbox = getBoot()?.outbox;
  if (blocker || !outbox) return { ok: false, reason: blocker ?? 'local_unavailable' };
  try {
    return { ok: true, item: await outbox.enqueue(input) };
  } catch (e) {
    if (e instanceof CacheClosedError) return { ok: false, reason: localWriteBlocker() === 'switching' ? 'switching' : 'closing' };
    if (e instanceof OutboxRejectError && e.code === 'outbox_suspended') return { ok: false, reason: 'switching' };
    throw e;
  }
}

function withOpts(input: EnqueueInput, opts: WriteOptions): EnqueueInput {
  const out: EnqueueInput = { ...input };
  if (opts.remind !== undefined) out.remind = opts.remind;
  if (opts.deps !== undefined) out.deps = opts.deps;
  return out;
}

// ───── settings 里 ai.enabled、ai.vault 两个键（架构 0.41 第 1、2 条；0.29 续第 146 条）─────
// 客户端对这两个键永远不发软删、不发撤销（删掉一行在 aiAllowed 里等于回到默认值，ai.vault 默认打开）；ai.vault 只能写 false。
// 服务器的 settings_guard 同样会拦（vault_required / settings_key_immutable），这里提前拦住、不入队，免得以后有人给设置加“撤销”时踩到
/** 只能改值、不能删、不能撤销的 settings 键 */
export const AI_SETTING_KEYS: readonly string[] = ['ai.enabled', 'ai.vault'];

/** 被拦时的码：和服务器 settings_guard 同一口径 */
const aiKeyCode = (key: string): string => (key === 'ai.vault' ? 'vault_required' : 'settings_key_immutable');

/** 这次写会不会删掉或撤销那一行（恢复：deleted_at 改回 null、undone 改回 false 不算） */
const removesRow = (data: Record<string, unknown>): boolean =>
  (Object.hasOwn(data, 'deleted_at') && data['deleted_at'] !== null) || data['undone'] === true;

/** settings 的写入守门；不该写时抛 OutboxRejectError（码同服务器）。patch 按本机集合里那一行的 key 判断，本机没有这一行时交给服务器拦 */
function guardSettings(input: EnqueueInput): void {
  if (input.table !== 'settings') return;
  const key = input.op === 'insert' ? input.data['key'] : collection<Row & { key?: unknown }>('settings').get(input.id)?.key;
  if (typeof key !== 'string' || !AI_SETTING_KEYS.includes(key)) return;
  if (removesRow(input.data)) throw new OutboxRejectError(aiKeyCode(key));
  if (key === 'ai.vault' && Object.hasOwn(input.data, 'value') && input.data['value'] !== false) throw new OutboxRejectError('vault_required');
}

export const write = {
  /** 新建一行（data 是整行可写列，含 id） */
  async insert(table: string, data: Record<string, unknown> & { id: string }, opts: WriteOptions = {}): Promise<WriteResult> {
    const input = withOpts({ table, id: data.id, op: 'insert', data }, opts);
    guardSettings(input);
    return enqueue(input);
  },
  /** 改一行（只放改了的列；删除、撤销也是 patch：deleted_at、undone） */
  async patch(table: string, id: string, data: Record<string, unknown>, opts: WriteOptions = {}): Promise<WriteResult> {
    const input = withOpts({ table, id, op: 'patch', data }, opts);
    guardSettings(input);
    return enqueue(input);
  },
};
