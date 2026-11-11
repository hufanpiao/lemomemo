// 光标对齐日志（台账 Q-8 诊断，非正式版）：诊断页“Caret sync”开关在本机存储放 ARM_KEY = '1'，冷启动 main.tsx 读到才动态加载。
// 对齐动作本身在 caret-align.ts（试验，只经本文件加载、只进非正式版）；这里启动它，并把每次对齐、补抬前后的数值记一行，
// 存 OUT_KEY，诊断页可整段复制给主持人
import { startCaretAlign } from './caret-align.ts';

export const ARM_KEY = 'lemo-caret-sync';
export const OUT_KEY = 'lemo-caret-sync-out';
export const MAX_LINES = 120;

export function caretSyncOn(store: Storage = localStorage): boolean {
  try {
    return store.getItem(ARM_KEY) === '1';
  } catch {
    return false;
  }
}

export function setCaretSyncOn(on: boolean, store: Storage = localStorage): void {
  try {
    if (on) store.setItem(ARM_KEY, '1');
    else store.removeItem(ARM_KEY);
  } catch {
    // 本机存储用不了：开关不生效
  }
}

export function readCaretSyncLog(store: Storage = localStorage): string {
  try {
    return store.getItem(OUT_KEY) ?? '';
  } catch {
    return '';
  }
}

/** 带日志启动光标对齐（main.tsx 冷启动调一次，代替不带日志的那次）；返回停止函数 */
export function startCaretSync(win: Window = window, store: Storage = localStorage, now: () => number = () => Date.now()): () => void {
  const t0 = now();
  const lines: string[] = [`caret-sync start=${new Date(t0).toISOString()} screen=${win.screen.width}x${win.screen.height}`];
  const save = (): void => {
    try {
      store.setItem(OUT_KEY, lines.join('\n'));
    } catch {
      // 存不下就算了
    }
  };
  save();
  return startCaretAlign(win, (s) => {
    lines.push(`t=${((now() - t0) / 1000).toFixed(2)} ${s}`);
    if (lines.length > MAX_LINES) lines.splice(1, 1);
    save();
  });
}
