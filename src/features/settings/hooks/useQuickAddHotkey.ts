// 设置 › 电脑 › 快速记录热键（R-297；只在 exe 里有）：读现在的热键、录新热键、恢复默认。
// Rust 一侧和热键写法在 platform/desktop-hotkey.ts（前端 B）；不在 exe 里 getQuickAddHotkey 回 null，这一项不显示
// • 录热键：按下的组合经 hotkeyFromKeyboardEvent 换成写法；只按修饰键不算（继续等），键不行（没有 Ctrl、Alt、Win 或键不在名单里）给一句提示、继续等；
//   Esc 取消；换出来的写法和现在的一样、且已注册上就直接结束，不调 Rust（没注册上时照样调 hotkey_set，让用户原样重试）
// • 改热键失败按 invalid、in_use、save_failed、failed 给提示；save_failed 时新热键这次已生效，状态照新的显示
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getQuickAddHotkey,
  hotkeyFromKeyboardEvent,
  setQuickAddHotkey,
  type HotkeySetResult,
  type HotkeyStatus,
  type KeyComboEvent,
} from '../../../platform/desktop-hotkey.ts';

export { hotkeyLabel } from '../../../platform/desktop-hotkey.ts';

export interface HotkeyApi {
  get(): Promise<HotkeyStatus | null>;
  set(accelerator: string): Promise<HotkeySetResult>;
}

export const defaultHotkeyApi: HotkeyApi = {
  get: () => getQuickAddHotkey(),
  set: (a) => setQuickAddHotkey(a),
};

/** 界面上的提示：Rust 回的四种失败，加上录热键时按了不能用的组合（combo） */
export type HotkeyNotice = 'invalid' | 'in_use' | 'save_failed' | 'failed' | 'combo';

const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

export interface QuickAddHotkey {
  /** null：不在 exe 里、读失败、或还没读回来（都不显示这一项） */
  status: HotkeyStatus | null;
  recording: boolean;
  saving: boolean;
  notice: HotkeyNotice | null;
  startRecording(): void;
  cancelRecording(): void;
  /** 录热键时的 keydown；返回 true 表示这个键已经处理（调用方 preventDefault） */
  onKey(e: KeyComboEvent & { key?: string }): boolean;
  resetDefault(): Promise<void>;
}

export function useQuickAddHotkey(api: HotkeyApi = defaultHotkeyApi): QuickAddHotkey {
  const [status, setStatus] = useState<HotkeyStatus | null>(null);
  const [recording, setRecording] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<HotkeyNotice | null>(null);
  const alive = useRef(true);
  const busy = useRef(false);

  useEffect(() => {
    alive.current = true;
    void api.get().then((s) => {
      if (alive.current) setStatus(s);
    });
    return () => {
      alive.current = false;
    };
  }, [api]);

  const apply = useCallback(
    async (accelerator: string): Promise<void> => {
      if (busy.current) return;
      busy.current = true;
      setSaving(true);
      const r = await api.set(accelerator);
      busy.current = false;
      if (!alive.current) return;
      setSaving(false);
      if (r.ok) {
        setStatus(r.status);
        setNotice(null);
        return;
      }
      setNotice(r.error);
      // save_failed：这次运行里新热键已生效（重读一次，显示 Rust 那边现在的）
      if (r.error === 'save_failed') {
        const s = await api.get();
        if (alive.current && s) setStatus(s);
      }
    },
    [api],
  );

  const startRecording = useCallback(() => {
    setNotice(null);
    setRecording(true);
  }, []);
  const cancelRecording = useCallback(() => setRecording(false), []);

  const onKey = useCallback(
    (e: KeyComboEvent & { key?: string }): boolean => {
      if (e.code === 'Escape' || e.key === 'Escape') {
        setRecording(false);
        return true;
      }
      if (e.code === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) return false; // 让 Tab 照常移焦点
      if (MODIFIER_CODES.test(e.code)) return true;
      const acc = hotkeyFromKeyboardEvent(e);
      if (acc === null) {
        setNotice('combo');
        return true;
      }
      setRecording(false);
      if (acc === status?.accelerator && status.registered) {
        setNotice(null);
        return true;
      }
      void apply(acc);
      return true;
    },
    [apply, status],
  );

  const resetDefault = useCallback(async () => {
    if (!status) return;
    setRecording(false);
    await apply(status.defaultAccelerator);
  }, [apply, status]);

  return { status, recording, saving, notice, startRecording, cancelRecording, onKey, resetDefault };
}
