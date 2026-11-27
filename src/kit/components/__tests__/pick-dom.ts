// 单测（jsdom）里操作 kit 选择器（Pick/Pick.tsx，11-21 换掉原生日期、时刻框和下拉）：和 tests/e2e/pick-helpers.ts 同一套认法——
// 值按钮的 data-value 是现在的值，格子的 data-v 是这一格的值（日子 'YYYY-MM-DD'、时 'h15'、分 'm30'、选项的值），不随语言变
import { act, fireEvent, screen, within } from '@testing-library/react';
import { cellOf, DAY_CELLS, MAX_WEEK_STEPS } from './pick-const.ts';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

/** 打开 testId 那个值按钮的选择器（已经开着就不再点），返回这一块 */
export function openPick(testId: string): HTMLElement {
  const btn = screen.getByTestId(testId);
  if (btn.getAttribute('aria-expanded') !== 'true') fireEvent.click(btn);
  const id = btn.getAttribute('aria-controls');
  const box = id ? document.getElementById(id) : null;
  if (!box) throw new Error(`选择器没打开：${testId}`);
  return box;
}

const cell = (box: HTMLElement, v: string): HTMLElement | null => box.querySelector<HTMLElement>(cellOf(v));

/**
 * 按值选：'YYYY-MM-DD' 是日期（按周翻到那一周再点“确定”），'HH:MM' 是时刻（点时、分再点“确定”），
 * 别的是下拉单选的选项值（点一下就选中收起）
 */
export async function pickValue(testId: string, value: string): Promise<void> {
  // fireEvent 自己包了 act，每点一下就画好；不能整段包进一个 act（里面的点击要等外层结束才画，选择器还没打开）
  const box = openPick(testId);
  if (DATE.test(value)) {
    for (let i = 0; i < MAX_WEEK_STEPS && !cell(box, value); i++) {
      const first = box.querySelector<HTMLElement>(DAY_CELLS)?.dataset['v'] ?? '';
      fireEvent.click(within(box).getByTestId(first > value ? 'pick-prev' : 'pick-next'));
    }
  }
  const at = TIME.test(value) ? [`h${value.slice(0, 2)}`, `m${value.slice(3, 5)}`] : [value];
  for (const v of at) {
    const c = cell(box, v);
    if (!c) throw new Error(`没有这一格：${v}`);
    fireEvent.click(c);
  }
  if (DATE.test(value) || TIME.test(value)) fireEvent.click(within(box).getByTestId('pick-ok'));
  // 等写入的 promise 走完（原来 fireEvent.change 外面包的那层 act）
  await act(async () => undefined);
}

/** 值按钮现在的值（没值为空串） */
export const valueOf = (testId: string): string => screen.getByTestId(testId).getAttribute('data-value') ?? '';

/** 下拉单选的全部选项文字（打开看一眼再收起） */
export function optionTexts(testId: string): string[] {
  const box = openPick(testId);
  const out = [...box.querySelectorAll<HTMLElement>('[data-v]')].map((el) => el.textContent);
  fireEvent.click(screen.getByTestId(testId));
  return out;
}
