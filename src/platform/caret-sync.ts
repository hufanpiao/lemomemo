// 光标偏位试验（台账 Q-8，11-11 根因：iOS 主屏幕版键盘弹出后 scrollY=353、visualViewport.offsetTop=291，差 62 = 顶部安全区，
// 打字条按一套坐标画、光标按另一套画，光标低 62pt）。只在非正式版里有：诊断页开关在本机存储放 ARM_KEY = '1'，冷启动 main.tsx 读到才动态加载。
// 做法：输入框聚焦、键盘弹完（visualViewport 停止变化 SETTLE_MS）后，滚动位置和可视区偏移差超过 TOL_PX，就 scrollTo(0, offsetTop) 让两套坐标对齐，
// 再在原位置重设一次选区，让 iOS 重新画光标。每次动作前后的数值记一行，存 OUT_KEY，诊断页可整段复制给主持人。
export const ARM_KEY = 'lemo-caret-sync';
export const OUT_KEY = 'lemo-caret-sync-out';
export const SETTLE_MS = 300;
export const TOL_PX = 2;
export const MAX_LINES = 120;

type Field = HTMLInputElement | HTMLTextAreaElement;

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

function isField(el: Element | null): el is Field {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/** 开始盯（main.tsx 冷启动调一次）；返回停止函数 */
export function startCaretSync(win: Window = window, store: Storage = localStorage, now: () => number = () => Date.now()): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => undefined;
  const t0 = now();
  const lines: string[] = [`caret-sync start=${new Date(t0).toISOString()} screen=${win.screen.width}x${win.screen.height}`];
  const save = (): void => {
    try {
      store.setItem(OUT_KEY, lines.join('\n'));
    } catch {
      // 存不下就算了
    }
  };
  const log = (s: string): void => {
    lines.push(`t=${((now() - t0) / 1000).toFixed(2)} ${s}`);
    if (lines.length > MAX_LINES) lines.splice(1, 1);
    save();
  };
  const state = (): string =>
    `inner=${win.innerHeight} vv=${Math.round(vv.height)} top=${Math.round(vv.offsetTop)} y=${Math.round(win.scrollY)}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settle = (): void => {
    const el = win.document.activeElement;
    if (!isField(el)) return;
    const r0 = el.getBoundingClientRect();
    const diff = Math.round(win.scrollY - vv.offsetTop);
    if (Math.abs(diff) <= TOL_PX) {
      log(`skip diff=${diff} ${state()} el=${Math.round(r0.top)}`);
      return;
    }
    const before = state();
    win.scrollTo(0, vv.offsetTop);
    const pos = el.selectionStart ?? el.value.length;
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      // 某些 type 不支持选区：只做滚动对齐
    }
    const r1 = el.getBoundingClientRect();
    log(`sync diff=${diff} before ${before} el=${Math.round(r0.top)} after ${state()} el=${Math.round(r1.top)}`);
  };
  const onChange = (): void => {
    clearTimeout(timer);
    timer = setTimeout(settle, SETTLE_MS);
  };
  vv.addEventListener('resize', onChange);
  vv.addEventListener('scroll', onChange);
  win.document.addEventListener('focusin', onChange);
  save();
  return () => {
    clearTimeout(timer);
    vv.removeEventListener('resize', onChange);
    vv.removeEventListener('scroll', onChange);
    win.document.removeEventListener('focusin', onChange);
  };
}
