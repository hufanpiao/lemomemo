// e2e 用的选择器操作（kit/components/Pick，11-21 换掉原生日期、时刻框和下拉）：
// 值按钮的 data-value 是现在的值（'YYYY-MM-DD'、'HH:MM'、选项的值），格子的 data-v 是这一格的值（日子 'YYYY-MM-DD'、时 'h15'、分 'm30'），
// 都不随语言变；按它点，不按读屏名点
import { expect, type Locator, type Page } from '@playwright/test';
import { cellOf, DAY_CELLS, MAX_WEEK_STEPS, monthCellOf } from '../../src/kit/components/__tests__/pick-const.ts';

/** 打开 testId 那个值按钮的选择器，返回这一块 */
export async function openPick(page: Page, testId: string): Promise<Locator> {
  const btn = page.getByTestId(testId);
  await btn.click();
  await expect(btn).toHaveAttribute('aria-expanded', 'true');
  const id = await btn.getAttribute('aria-controls');
  if (!id) throw new Error(`选择器没打开：${testId}`);
  return page.locator(`[id="${id}"]`);
}

/** 选日期（按周翻到那一周）、时、分，点“确定” */
export async function pick(page: Page, testId: string, v: { date?: string; time?: string }): Promise<void> {
  const box = await openPick(page, testId);
  if (v.date) {
    for (let i = 0; i < MAX_WEEK_STEPS && (await box.locator(cellOf(v.date)).count()) === 0; i++) {
      const first = await box.locator(DAY_CELLS).first().getAttribute('data-v');
      await box.getByTestId(first !== null && first > v.date ? 'pick-prev' : 'pick-next').click();
    }
    await box.locator(cellOf(v.date)).click();
  }
  if (v.time) {
    await box.locator(cellOf(`h${v.time.slice(0, 2)}`)).click();
    await box.locator(cellOf(`m${v.time.slice(3, 5)}`)).click();
  }
  await box.getByTestId('pick-ok').click();
  await expect(box).toHaveCount(0);
}

/** 点周标题弹出月份列表，点 ym（'YYYY-MM'）那个月跳过去（负责人 11-23“点周标题弹月份”） */
export async function jumpMonth(box: Locator, ym: string): Promise<void> {
  const title = box.getByTestId('pick-title');
  await title.click();
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  await box.locator(monthCellOf(ym)).click();
  await expect(title).toHaveAttribute('aria-expanded', 'false');
}

/** 点选择器左上的“清空” */
export async function clearPick(page: Page, testId: string): Promise<void> {
  const box = await openPick(page, testId);
  await box.getByTestId('pick-clear').click();
  await expect(box).toHaveCount(0);
}

/** 下拉单选：打开、点那个选项（点一下就收起） */
export async function pickOption(page: Page, testId: string, value: string): Promise<void> {
  const box = await openPick(page, testId);
  await box.locator(cellOf(value)).click();
  await expect(box).toHaveCount(0);
}
