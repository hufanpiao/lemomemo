// settings 一行“改值 / 顺带恢复”的 patch 内容（架构 2.3 A31、0.41 第 1、2 条；B2 安全审查 FA3-2）
// 纯函数，不 import 任何东西：core/ai-settings.ts（ai.enabled、ai.vault）和 core/setting-write.ts（提醒 remind.*、日历 cal.* 共用的那一份）用，
// 恢复（deleted_at → null、undone → false）只在这一处写，别处不再自己对 settings 的 patch 写这两个键
/**
 * settings 已有的一行改成 value 要 patch 什么（A31 的恢复写法只在这里，代码审查 / 安全审查 FA3-2：别处要恢复就调它，不再自己写成员赋值）：
 * 只写 value；那一行被软删或撤销过就顺带恢复（deleted_at 改回 null、undone 改回 false，只会是这两个“恢复”值）；
 * 值一样、也没被删没被撤销返回 null（不写）。用到的：core/ai-settings.ts 的 writeOn、core/setting-write.ts 的 settingWrite
 */
export function settingPatch(row: { readonly value?: unknown; readonly deleted_at?: unknown; readonly undone?: unknown }, value: unknown): Record<string, unknown> | null {
  const removed = row.deleted_at !== null && row.deleted_at !== undefined;
  const undone = row.undone === true;
  if (row.value === value && !removed && !undone) return null;
  const data: Record<string, unknown> = { value };
  if (removed) data['deleted_at'] = null;
  if (undone) data['undone'] = false;
  return data;
}
