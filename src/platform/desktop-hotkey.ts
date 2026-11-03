// exe 的快速记录热键（负责人 R-297）：默认 Ctrl+Shift+空格，设置里能改，注册失败时设置页提示“热键被占用”。
// 壳子一侧在 desktop/src-tauri/src/hotkey.rs 和 lib.rs 的 hotkey_get / hotkey_set（只给 main 窗口）。
// 设置页的界面归前端 A；这里只给三样：读状态、改热键、把键盘事件换成热键写法。只在 exe 里用，网页版没有这一项。
//
// 写法：修饰键 + 一个键，用“+”连，固定顺序 Ctrl+Alt+Shift+Win+键；键是 A～Z、0～9、F1～F12、Space。
// 至少要有 Ctrl、Alt、Win 里的一个（只有 Shift 的组合打字会误触）；Ctrl 或 Alt 单独作修饰键时，必须再带 Shift、Win 或另一个
// 修饰键（安全审查 B-2：Ctrl+C、Ctrl+V、Alt+F4 这些系统常用键会被抢走全系统的组合）；只有 Win 的可以，
// 但 Win+Space（Windows 切换输入法）不收。
// Rust 那边按同一套规矩再核一遍，以 Rust 为准。

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Rust 的 hotkey::HotkeyStatus */
export interface HotkeyStatus {
  /** 现在用的热键，比如 "Ctrl+Shift+Space" */
  readonly accelerator: string;
  /** 默认热键（“恢复默认”用） */
  readonly defaultAccelerator: string;
  /** false：这个热键没注册上（启动时就被别的程序占了），设置页提示“热键被占用” */
  readonly registered: boolean;
}

/**
 * 改热键的结果。失败原因：
 * • invalid：写法不合规矩（界面先用 hotkeyFromKeyboardEvent 拦，一般到不了这里）；
 * • in_use：被别的程序占了，提示“热键被占用”；旧热键照样能用；
 * • save_failed：这次运行里新热键已生效，但没存下来，下次启动回到旧的；
 * • failed：其余（不在 exe 里、Rust 出错、回了认不出的东西）
 */
export type HotkeySetResult =
  | { readonly ok: true; readonly status: HotkeyStatus }
  | { readonly ok: false; readonly error: 'invalid' | 'in_use' | 'save_failed' | 'failed' };

const ERRORS: Record<string, 'invalid' | 'in_use' | 'save_failed'> = {
  hotkey_invalid: 'invalid',
  hotkey_in_use: 'in_use',
  hotkey_save_failed: 'save_failed',
};

function tauriInvoke(): Invoke | undefined {
  const internals = (globalThis as { __TAURI_INTERNALS__?: { invoke?: Invoke } }).__TAURI_INTERNALS__;
  const invoke = internals?.invoke;
  return typeof invoke === 'function' ? (cmd, args) => invoke(cmd, args) : undefined;
}

/** Rust 回来的状态核一遍形状，认不出返回 null */
export function toHotkeyStatus(v: unknown): HotkeyStatus | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.accelerator !== 'string' || typeof o.defaultAccelerator !== 'string' || typeof o.registered !== 'boolean') return null;
  return { accelerator: o.accelerator, defaultAccelerator: o.defaultAccelerator, registered: o.registered };
}

/** 设置页打开时调：现在的热键和有没有注册上；不在 exe 里、或读失败返回 null（不显示这一项） */
export async function getQuickAddHotkey(invoke: Invoke | undefined = tauriInvoke()): Promise<HotkeyStatus | null> {
  if (!invoke) return null;
  try {
    return toHotkeyStatus(await invoke('hotkey_get'));
  } catch {
    return null;
  }
}

/** 改热键（“恢复默认”就传 defaultAccelerator） */
export async function setQuickAddHotkey(accelerator: string, invoke: Invoke | undefined = tauriInvoke()): Promise<HotkeySetResult> {
  if (!invoke) return { ok: false, error: 'failed' };
  try {
    const status = toHotkeyStatus(await invoke('hotkey_set', { accelerator }));
    return status ? { ok: true, status } : { ok: false, error: 'failed' };
  } catch (e) {
    const code = typeof e === 'string' ? e : e instanceof Error ? e.message : '';
    return { ok: false, error: ERRORS[code] ?? 'failed' };
  }
}

/** 键盘事件里用到的字段 */
export interface KeyComboEvent {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

/**
 * 设置页“按下新热键”时，把 keydown 事件换成热键写法；不能当热键的（只按了修饰键、键不在名单里、只有 Shift、
 * 只有 Ctrl 或只有 Alt 一个修饰键、Win+Space）返回 null。
 * 按 event.code（物理键位）认键，不看 event.key，不受输入法和键盘布局影响
 */
export function hotkeyFromKeyboardEvent(e: KeyComboEvent): string | null {
  let key: string | null = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-2])$/.test(e.code)) key = e.code;
  else if (e.code === 'Space') key = 'Space';
  if (!key || !(e.ctrlKey || e.altKey || e.metaKey)) return null;
  // B-2：Ctrl 或 Alt 单独作修饰键不收
  if (!e.shiftKey && !e.metaKey && e.ctrlKey !== e.altKey) return null;
  // Win+Space 是 Windows 切换输入法的系统热键
  if (key === 'Space' && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) return null;
  const parts = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win'].filter((x): x is string => !!x);
  return [...parts, key].join('+');
}

/** 显示用：Space 换成界面语言里的“空格”（spaceLabel 由设置页从 i18n 取，A20 不许在这里写死），加号两边留空 */
export function hotkeyLabel(accelerator: string, spaceLabel: string): string {
  return accelerator
    .split('+')
    .map((p) => (p === 'Space' ? spaceLabel : p))
    .join(' + ');
}
