// 单测（pick-dom.ts）和 e2e（tests/e2e/pick-helpers.ts）操作 kit 选择器共用的两样（评审第 17 条：原来两边各写一份）
// 日子格的 data-v 是 'YYYY-MM-DD'（年份 1、2 开头），时、分格是 'h15'、'm30'，选项是选项的值

/** 周条里的日子格（翻周时取第一格的日期，判断往前还是往后翻） */
export const DAY_CELLS = '[data-v^="1"], [data-v^="2"]';

/** 按周翻到目标日期最多翻几次（80 周，一年半多；超过说明翻错了方向或日期不在范围里） */
export const MAX_WEEK_STEPS = 80;

/** 值为 v 的那一格 */
export const cellOf = (v: string): string => `[data-v="${v}"]`;

/** 月份列表（点周标题弹出，11-23）里那个月的胶囊：data-v 是 'ym' + 'YYYY-MM'（不和日子格的 DAY_CELLS 撞） */
export const monthCellOf = (ym: string): string => cellOf(`ym${ym}`);
