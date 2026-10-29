// settings 里的两个 AI 开关 ai.enabled、ai.vault 的唯一写法（架构 15.5、0.41 第 2 条、0.29 续第 146 条）
// • 只写 value：关掉就是 value = false，永远不发软删（deleted_at）、不发撤销（undone）；write.* 里另有守门，发了也入不了队；
//   源码一侧由 ESLint lemo/settings-ai-write（架构 2.3 A31）拦：别处不准对 settings 写 deleted_at / undone、不准用 write.* 写这两个键
// • ai.vault 只能写 false（打开只能经服务器 set_ai_vault，要 vault_token），类型上就写不出 true
// • 本机集合里已有这一行：patch value；那一行被软删或撤销过（服务器以前留下的）就顺带恢复（deleted_at 改回 null、undone 改回 false，
//   恢复不被 settings_guard 拦，0.41 第 1 条）；本机没有这一行：insert 一行新的（id 本机生成）
// • 值已经一样、也没被删：不写，返回 { ok: true, item: null }
// • 本机还没拉到服务器上已有的那一行时 insert 会和 (user_id, key) 唯一约束撞上（CONSENT-sugg ②）：首次告知页（consent_policy_ver 为空）时
//   服务器上一般没有 ai.enabled 行（只有 record_consent 的撤回分支写它，写了就有版本号），以后从设置页重开告知页时才可能碰到。
//   writeAiSwitchSettled 兜这一种：insert 那一项被服务器拒（outbox 的 error / rejected 事件）以后，等同步把服务器那一行拉进集合，
//   再按那一行 patch 一次；SETTLE_MS 内没等到就算了（AI 只是还没打开，设置 › 语音与 AI 能再开）
// 纯 TS：不准 import React 和任何功能（A1）
import { getBoot } from './boot.ts';
import { collection, type Row } from './store.ts';
import { write, type WriteResult } from './write.ts';

export type AiSwitch = { key: 'ai.enabled'; value: boolean } | { key: 'ai.vault'; value: false };

interface SettingsRow extends Row {
  key?: unknown;
  value?: unknown;
  deleted_at?: unknown;
  undone?: unknown;
}

const settings = () => collection<SettingsRow>('settings');

/** 本机集合里这个键的那一行（skipId：不算这一行，等服务器那一行时用） */
function rowOf(key: string, skipId?: string): SettingsRow | undefined {
  return settings()
    .getSnapshot()
    .find((r) => r.key === key && r.id !== skipId);
}

export function writeAiSwitch(sw: AiSwitch, newId: () => string = () => crypto.randomUUID()): Promise<WriteResult> {
  return writeOn(sw, rowOf(sw.key), newId);
}

/** 按给定的那一行写（没有就 insert） */
async function writeOn(sw: AiSwitch, row: SettingsRow | undefined, newId: () => string): Promise<WriteResult> {
  if (!row) return write.insert('settings', { id: newId(), key: sw.key, value: sw.value });
  const removed = row.deleted_at !== null && row.deleted_at !== undefined;
  const undone = row.undone === true;
  if (row.value === sw.value && !removed && !undone) return { ok: true, item: null };
  const data: Record<string, unknown> = { value: sw.value };
  if (removed) data['deleted_at'] = null;
  if (undone) data['undone'] = false;
  return write.patch('settings', row.id, data);
}

/** insert 被拒以后最多等多久服务器那一行（同步一轮拉取一般几秒；离线时等不到就算了） */
export const AI_SWITCH_SETTLE_MS = 120_000;

/**
 * 同 writeAiSwitch；这次是 insert 时在后台盯着：那一项被服务器拒了，就等同步把服务器上那一行拉进本机集合，再 patch 一次（CONSENT-sugg ②）。
 * 返回值是第一次写的结果（不等后台那一步）。settleMs 到了还没等到就停，不重试第二次
 */
export async function writeAiSwitchSettled(
  sw: AiSwitch,
  o: { newId?: () => string; settleMs?: number } = {},
): Promise<WriteResult> {
  const r = await writeAiSwitch(sw, o.newId);
  const item = r.ok ? r.item : null;
  const outbox = getBoot()?.outbox;
  if (!item || item.op !== 'insert' || !outbox) return r;
  let offRow: () => void = () => undefined;
  const stop = (): void => {
    clearTimeout(timer);
    offEvent();
    offRow();
  };
  const timer = setTimeout(stop, o.settleMs ?? AI_SWITCH_SETTLE_MS);
  /** 服务器那一行到了：按它 patch，停 */
  const tryPatch = (): boolean => {
    const row = rowOf(sw.key, item.id);
    if (!row) return false;
    stop();
    void writeOn(sw, row, () => crypto.randomUUID()).catch(() => undefined);
    return true;
  };
  const offEvent = outbox.onEvent((e) => {
    if ((e.type !== 'error' && e.type !== 'rejected') || e.item.op_id !== item.op_id) return;
    offEvent();
    if (!tryPatch()) offRow = settings().subscribe(() => void tryPatch());
  });
  return r;
}
