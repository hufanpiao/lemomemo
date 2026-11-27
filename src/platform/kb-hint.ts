// 打字条打开时直接停在“上次键盘上沿”的位置：聚焦后键盘出来、输入框跟着 --kb 往上跳时，系统画的光标会跟不上这次位移。
// 做法：记住上次键盘的高度，打开时先把 --kb-hint 写在根节点上（打字条的 bottom 取它和 --dock-bottom 里大的），
// 聚焦那一刻输入框就已经在最终位置，键盘出来以后不再移动。
// • 键盘真的出来了（--kb 写上了）：记下这次的高度，撤掉 --kb-hint（之后位置只由 --kb 管，收键盘照旧落回底部）
// • WAIT_MS 内键盘没出来（接了实体键盘）：撤掉，打字条落回底部，并忘掉记住的高度，下次不再先抬
//   （冷启动系统慢一拍也会忘掉；改不改先看运行日志里 kbhint off why=timeout 多不多）
// 键盘高度由 viewport.ts 直接给：watchKeyboard 回调里读 keyboardOverPx（就是它刚写到根节点 --kb 的那个值）。
// 只由懒加载的打字条引用，不进首屏（viewport.ts 打字条本来就引）
import { rlog } from './run-log-api.ts';
import { keyboardOverPx, watchKeyboard } from './viewport.ts';
import { KB_VAR } from './viewport-screen.ts';

export const KB_HINT_VAR = '--kb-hint';
const KEY = 'lemo.kb-last';
const WAIT_MS = 900;
const MIN_PX = 120;
const MAX_PX = 900;

function readLast(): number {
  try {
    const n = Number(localStorage.getItem(KEY));
    return Number.isFinite(n) && n >= MIN_PX && n <= MAX_PX ? Math.round(n) : 0;
  } catch {
    return 0;
  }
}

function writeLast(px: number): void {
  try {
    if (px > 0) localStorage.setItem(KEY, String(px));
    else localStorage.removeItem(KEY);
  } catch {
    // 存不了就每次都不先抬
  }
}

/** 打字条要聚焦之前调（同一个任务里）；返回收尾函数（打字条收起、卸掉时调） */
export function holdForKeyboard(): () => void {
  const root = document.documentElement;
  let last = readLast();
  const remember = (px: number): void => {
    if (px === last) return;
    last = px;
    writeLast(px);
  };
  let held = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drop = (why: string): void => {
    if (!held) return;
    held = false;
    clearTimeout(timer);
    root.style.removeProperty(KB_HINT_VAR);
    rlog(`kbhint off why=${why}`);
  };
  // viewport.ts 写完 --kb 当场叫回调（同一个任务里，撤掉和 --kb 生效落在同一帧）
  const off = watchKeyboard(() => {
    const kb = Math.round(keyboardOverPx());
    if (kb < MIN_PX) return;
    remember(kb);
    drop('kb');
  });
  const kbNow = Number.parseFloat(root.style.getPropertyValue(KB_VAR)) || 0;
  if (last > 0 && kbNow < MIN_PX) {
    held = true;
    root.style.setProperty(KB_HINT_VAR, `${last}px`);
    rlog(`kbhint on px=${last}`);
    timer = setTimeout(() => {
      if (!held) return;
      remember(0);
      drop('timeout');
    }, WAIT_MS);
  }
  return () => {
    off();
    drop('close');
  };
}
