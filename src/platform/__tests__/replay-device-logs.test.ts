// 真机日志回放（11-11 负责人“这些问题自己测试测不出来？？？？？”）：电脑上的浏览器没有 iOS 主屏幕版少算顶部安全区那 62pt 的毛病，
// 所以把负责人真机日志里的数值原样按顺序喂进去，逐步算底栏在屏幕上的位置，不在“焊死”的那个位置又露着就不过。
// 屏幕上的位置按真机时间线反推：fixed 贴底元素的下沿在屏幕上 = 布局视口下沿（innerHeight）− bottom；
// 时间线里 inner=895 时底栏下沿 bar=853（= 895 − 8 − 34），inner=956 时 914（= 956 − 8 − 34），和这个算法一致。
// 底栏、“＋”只按根节点 data-kbhide 藏（CSS），所以“藏没藏”读根节点属性；每一步再核 watch 回调报的开关和它一致。
// 日志原文存 scratchpad（不进仓库），这里只留数值。
// 冷启动少的那截由垫块把 innerHeight 修回来（vh-gapfix-gate.ts）；之后再少（键盘弹到一半切页）由 --vh-gap 把底栏补到屏幕底，下面算位置时减它
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BAR_HIDE_ATTR, GAP_VAR } from '../viewport-geom.ts';
import { createKeyboardWatcher } from '../viewport.ts';

const SCREEN = 956;
const INSET_BOTTOM = 34;
/** 底栏 bottom: calc(8px + var(--inset-bottom) - var(--vh-gap, 0px))（kit GlassBar） */
const barBottomOnScreen = (inner: number, gap = 0): number => inner - (8 + INSET_BOTTOM - gap);
/** 焊死的位置：整屏 956 时底栏下沿 */
const WELDED = barBottomOnScreen(SCREEN);

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
  const attrs = new Map<string, string>();
  const root = {
    style: { setProperty: (k: string, v: string) => vars.set(k, v), removeProperty: (k: string) => vars.delete(k) },
    setAttribute: (k: string, v: string) => attrs.set(k, v),
    removeAttribute: (k: string) => attrs.delete(k),
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
  /** watch 回调最后报的开关 */
  let reported = false;
  w.watch((open) => (reported = open));
  /** 底栏藏没藏：根节点 data-kbhide（底栏、“＋”的 CSS 只认它） */
  const hidden = (): boolean => attrs.get(BAR_HIDE_ATTR) === '1';
  /** 每一步：data-kbhide 和 watch 回调一致；底栏藏着就不管位置，露着就必须在焊死的位置 */
  const problems: string[] = [];
  const agree = (label: string): void => {
    if (hidden() !== reported) problems.push(`${label}: data-kbhide=${hidden() ? 1 : 0}，watch 报 ${reported ? 1 : 0}`);
  };
  const step = (label: string, h: number, vvHeight = h): void => {
    inner = h;
    vv.height = vvHeight;
    vvH.get('resize')?.();
    agree(label);
    if (hidden()) return;
    const at = barBottomOnScreen(inner, parseFloat(vars.get(GAP_VAR) ?? '0'));
    if (at !== WELDED) problems.push(`${label}: 底栏露着、下沿在 ${at}（应在 ${WELDED}）`);
  };
  return {
    step,
    problems,
    focus: (v: boolean) => {
      editing = v;
      docH.get(v ? 'focusin' : 'focusout')?.();
      agree(v ? 'focusin' : 'focusout');
    },
    wait: (ms: number) => {
      vi.advanceTimersByTime(ms);
      agree(`等 ${ms}ms`);
    },
    isHidden: hidden,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('真机日志回放：底栏焊死（台账 Q-13、R-395）', () => {
  it('时间线 16:27（待办点＋：956 → 键盘 542 → 收起 895 → 0.33 秒后回到 956）：底栏不在半路露面', () => {
    const r = rig();
    r.step('键盘没弹 956', 956);
    r.focus(true);
    r.step('键盘弹起 542', 542);
    expect(r.isHidden()).toBe(true);
    r.focus(false);
    r.step('键盘收起中（可视区还矮）', 895, 700);
    r.step('键盘收完 895', 895);
    expect(r.isHidden()).toBe(true);
    r.wait(330);
    r.step('系统自己回到 956', 956);
    expect(r.problems).toEqual([]);
    expect(r.isHidden()).toBe(false);
  });

  it('负责人 11-26 t=1027～1076（待办备注键盘弹到一半就左滑回今天页：956 ↔ 906 来回跳，最后停在 906 约 48 秒）：底栏一直在原位', () => {
    const r = rig();
    r.step('键盘没弹 956', 956);
    r.focus(true);
    r.step('键盘弹起 540', 540);
    r.focus(false);
    // 真机 t=1028.15～1028.32 的 vv 行原样：inner 540 → 956 → 906 → 956 → 906
    for (const [label, h] of [['540', 540], ['956', 956], ['906', 906], ['956 再一次', 956], ['906 停住', 906]] as const) r.step(`收起中 ${label}`, h);
    r.wait(1000);
    r.step('之后一直 906', 906);
    expect(r.isHidden()).toBe(false);
    expect(r.problems).toEqual([]);
  });
});
