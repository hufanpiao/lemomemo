// 真机日志回放（11-11 负责人“这些问题自己测试测不出来？？？？？”）：电脑上的浏览器没有 iOS 主屏幕版少算顶部安全区那 62pt 的毛病，
// 所以把负责人真机日志里的数值原样按顺序喂进去，逐步算底栏在屏幕上的位置，不在“焊死”的那个位置又露着就不过。
// 屏幕上的位置按真机时间线反推：fixed 贴底元素的下沿在屏幕上 = 布局视口下沿（innerHeight）− bottom；
// 时间线里 inner=895 时底栏下沿 bar=853（= 895 − 8 − 34），inner=956 时 914（= 956 − 8 − 34），和这个算法一致。
// 日志原文存 scratchpad（不进仓库），这里只留数值
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKeyboardWatcher, GAP_VAR } from '../viewport.ts';

const SCREEN = 956;
const INSET_BOTTOM = 34;
/** 底栏 bottom: calc(8px + var(--inset-bottom) - var(--vh-gap, 0px))（kit GlassBar） */
const barBottomOnScreen = (inner: number, vhGap: number): number => inner - (8 + INSET_BOTTOM - vhGap);
/** 焊死的位置：整屏 956 时底栏下沿 */
const WELDED = barBottomOnScreen(SCREEN, 0);

function rig() {
  vi.useFakeTimers();
  let inner = SCREEN;
  let editing = false;
  const vvH = new Map<string, () => void>();
  const docH = new Map<string, () => void>();
  const vv = {
    height: SCREEN,
    offsetTop: 0,
    scale: 1,
    addEventListener: (k: string, f: () => void) => vvH.set(k, f),
    removeEventListener: (k: string) => vvH.delete(k),
  };
  const vars = new Map<string, string>();
  const root = {
    style: { setProperty: (k: string, v: string) => vars.set(k, v), removeProperty: (k: string) => vars.delete(k) },
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
  };
  const w = createKeyboardWatcher({
    vv: () => vv as never,
    innerHeight: () => inner,
    root: () => root as never,
    doc: () => ({ addEventListener: (k: string, f: () => void) => docH.set(k, f), removeEventListener: (k: string) => docH.delete(k) }) as never,
    standalone: () => true,
    editing: () => editing,
    full: () => SCREEN,
    phone: () => true,
    now: () => Date.now(),
  });
  let hidden = false;
  w.watch((open) => (hidden = open));
  /** 每一步：底栏藏着就不管位置；露着就必须在焊死的位置 */
  const problems: string[] = [];
  const step = (label: string, h: number, vvHeight = h): void => {
    inner = h;
    vv.height = vvHeight;
    vvH.get('resize')?.();
    if (hidden) return;
    const gap = Number.parseFloat(vars.get(GAP_VAR) ?? '0');
    const at = barBottomOnScreen(inner, gap);
    if (at !== WELDED) problems.push(`${label}: 底栏露着、下沿在 ${at}（应在 ${WELDED}）`);
  };
  return {
    step,
    problems,
    focus: (v: boolean) => {
      editing = v;
      docH.get(v ? 'focusin' : 'focusout')?.();
    },
    wait: (ms: number) => vi.advanceTimersByTime(ms),
    isHidden: () => hidden,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('真机日志回放：底栏焊死（台账 Q-13、R-395）', () => {
  it('Gap fix 日志 17:43（冷启动 894→895，早试误撤垫块，t=1294 才 956）：895 那 1.3 秒底栏也在原位', () => {
    const r = rig();
    r.step('冷启动 894', 894);
    r.step('抖成 895', 895);
    r.wait(1200);
    r.step('Gap fix 补回 956', 956);
    expect(r.problems).toEqual([]);
  });

  it('时间线 16:27（待办点＋：956 → 键盘 542 → 收起 895 → 0.33 秒后 956）：底栏不在半路露面', () => {
    const r = rig();
    r.step('键盘没弹 956', 956);
    r.focus(true);
    r.step('键盘弹起 542', 542);
    expect(r.isHidden()).toBe(true);
    r.focus(false);
    r.step('键盘收起中（可视区还矮）', 895, 700);
    r.step('键盘收完 895', 895);
    r.wait(330);
    r.step('Gap fix 补回 956', 956);
    expect(r.problems).toEqual([]);
    expect(r.isHidden()).toBe(false);
  });

  it('Gap fix 关着、一直停在 895：1 秒后露出来，也在原位', () => {
    const r = rig();
    r.focus(true);
    r.step('键盘弹起 542', 542);
    r.focus(false);
    r.step('键盘收完 895', 895);
    r.wait(1000);
    expect(r.isHidden()).toBe(false);
    r.step('停在 895', 895);
    expect(r.problems).toEqual([]);
  });

  it('对照（证明回放抓得到问题）：不写 --vh-gap 时 895 那一刻底栏高 61', () => {
    expect(barBottomOnScreen(895, 0)).toBe(WELDED - 61);
  });
});
