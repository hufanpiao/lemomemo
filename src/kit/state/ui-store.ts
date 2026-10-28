// 跨功能的界面状态（架构 2.0、2.1）：当前弹层、提示条队列、提醒横幅队列、界面语言
// 只放界面状态，不放数据（数据在 core/store）；某个功能自己的状态放在功能里（例如录音面板在 features/plus）
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import type { Locale } from '../../../shared/i18n/i18n.ts';
import type { SharedMsgKey } from '../../../shared/i18n/i18n.ts';

export interface Toast {
  id: string;
  /** 文案键（只存键和参数，显示时再翻译，换语言时跟着变） */
  key: SharedMsgKey;
  params: Readonly<Record<string, string | number>>;
}

export interface Banner {
  id: string;
  kind: 'remind' | 'update' | 'upgrade-required';
}

export interface UiState {
  locale: Locale;
  /** 打开着的弹层，后开的在后面 */
  overlays: readonly string[];
  toasts: readonly Toast[];
  banners: readonly Banner[];
  setLocale(locale: Locale): void;
  openOverlay(id: string): void;
  closeOverlay(id: string): void;
  pushToast(t: Toast): void;
  dismissToast(id: string): void;
  pushBanner(b: Banner): void;
  dismissBanner(id: string): void;
}

export const uiStore = createStore<UiState>()((set) => ({
  locale: 'zh-CN',
  overlays: [],
  toasts: [],
  banners: [],
  setLocale: (locale) => set({ locale }),
  openOverlay: (id) => set((s) => (s.overlays.includes(id) ? s : { overlays: [...s.overlays, id] })),
  closeOverlay: (id) => set((s) => ({ overlays: s.overlays.filter((x) => x !== id) })),
  pushToast: (t) => set((s) => ({ toasts: [...s.toasts.filter((x) => x.id !== t.id), t] })),
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
  pushBanner: (b) => set((s) => ({ banners: [...s.banners.filter((x) => x.id !== b.id), b] })),
  dismissBanner: (id) => set((s) => ({ banners: s.banners.filter((x) => x.id !== id) })),
}));

/** React 里按需取一部分：useUi((s) => s.locale) */
export function useUi<T>(selector: (s: UiState) => T): T {
  return useStore(uiStore, selector);
}
