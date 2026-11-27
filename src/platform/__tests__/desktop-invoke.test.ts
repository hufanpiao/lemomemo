// desktop-invoke.ts：exe 里取 __TAURI_INTERNALS__ 只有这一处（11-24 独立评审：invoke 三份合成一份）
import { describe, expect, it, vi } from 'vitest';
import { tauriEvents, tauriInvoke, tauriWindowLabel } from '../desktop-invoke.ts';

describe('desktop-invoke', () => {
  it('不在 exe 里：invoke 是 undefined、label 是 undefined、订阅事件抛 not_tauri', () => {
    for (const win of [{}, { __TAURI_INTERNALS__: null }, { __TAURI_INTERNALS__: {} }]) {
      expect(tauriInvoke(win)).toBeUndefined();
      expect(tauriWindowLabel(win)).toBeUndefined();
      expect(() => tauriEvents(win)).toThrow('not_tauri');
    }
  });

  it('在 exe 里：invoke 原样转参数（含字节和请求头）、读得到窗口 label、有 transformCallback 才能订阅', async () => {
    const invoke = vi.fn(() => Promise.resolve('ok'));
    const win = { __TAURI_INTERNALS__: { invoke, metadata: { currentWindow: { label: 'auth' } } } };
    const call = tauriInvoke(win);
    const bytes = new Uint8Array([1, 2]);
    await expect(call?.('save_bytes', bytes, { headers: { 'lemo-name': 'a' } })).resolves.toBe('ok');
    expect(invoke).toHaveBeenCalledWith('save_bytes', bytes, { headers: { 'lemo-name': 'a' } });
    expect(tauriWindowLabel(win)).toBe('auth');
    expect(() => tauriEvents(win)).toThrow('not_tauri');
    const withCb = { __TAURI_INTERNALS__: { invoke, transformCallback: () => 1 } };
    expect(tauriEvents(withCb).transformCallback(() => undefined)).toBe(1);
  });
});
