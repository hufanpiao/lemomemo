// settings 里的两个 AI 开关 ai.enabled、ai.vault 的唯一写法（架构 15.5、0.41 第 2 条、0.29 续第 146 条）
// • 只写 value：关掉就是 value = false，永远不发软删（deleted_at）、不发撤销（undone）；write.* 里另有守门，发了也入不了队
// • ai.vault 只能写 false（打开只能经服务器 set_ai_vault，要 vault_token），类型上就写不出 true
// • 本机集合里已有这一行：patch value；那一行被软删或撤销过（服务器以前留下的）就顺带恢复（deleted_at 改回 null、undone 改回 false，
//   恢复不被 settings_guard 拦，0.41 第 1 条）；本机没有这一行：insert 一行新的（id 本机生成）
// • 值已经一样、也没被删：不写，返回 { ok: true, item: null }
// • 已知局限：本机还没拉到服务器上已有的那一行时会 insert，和 (user_id, key) 唯一约束撞上；首次告知页（consent_policy_ver 为空）时
//   服务器上不会有 ai.enabled 行（只有 record_consent 的撤回分支写它，写了就有版本号），所以只在以后从设置页重开告知页时才可能碰到
// 纯 TS：不准 import React 和任何功能（A1）
import { collection, type Row } from './store.ts';
import { write, type WriteResult } from './write.ts';

export type AiSwitch = { key: 'ai.enabled'; value: boolean } | { key: 'ai.vault'; value: false };

interface SettingsRow extends Row {
  key?: unknown;
  value?: unknown;
  deleted_at?: unknown;
  undone?: unknown;
}

export async function writeAiSwitch(sw: AiSwitch, newId: () => string = () => crypto.randomUUID()): Promise<WriteResult> {
  const row = collection<SettingsRow>('settings')
    .getSnapshot()
    .find((r) => r.key === sw.key);
  if (!row) return write.insert('settings', { id: newId(), key: sw.key, value: sw.value });
  const removed = row.deleted_at !== null && row.deleted_at !== undefined;
  const undone = row.undone === true;
  if (row.value === sw.value && !removed && !undone) return { ok: true, item: null };
  const data: Record<string, unknown> = { value: sw.value };
  if (removed) data['deleted_at'] = null;
  if (undone) data['undone'] = false;
  return write.patch('settings', row.id, data);
}
