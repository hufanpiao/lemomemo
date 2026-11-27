// exe 快速记录小窗口调的两个 Rust 命令（capabilities/quick-add.json 只给这两个）：把一句话交给 main、收起自己。
// 这个窗口不连服务器、不碰会话，解析和保存都在 main。
import { tauriInvoke, type Invoke } from './desktop-invoke.ts';

/** 一句话最长多少字符（和 Rust 的 quick_add::MAX_CHARS 一致，两边读 tests/fixtures/desktop-shared-rules.json 对拍） */
export const QUICK_ADD_MAX_CHARS = 2000;

export async function submitQuickAdd(text: string, invoke: Invoke | undefined = tauriInvoke()): Promise<void> {
  if (!invoke) throw new Error('not_tauri');
  await invoke('quick_add_submit', { text });
}

export async function hideQuickAdd(invoke: Invoke | undefined = tauriInvoke()): Promise<void> {
  if (!invoke) throw new Error('not_tauri');
  await invoke('quick_add_hide');
}
