// 电脑版布局（架构 5.9b 第 2 点，R-120、R-126 方案 B）：settings 里 layout.<页>@inst:<install_id> 一行的值。
// 只存块的 id、顺序、栏宽比例、收起、抽屉在哪边、是否锁定，不存任何内容（一份通常不到 300 字节，受 settings 4 KB 上限约束）。
// 这里只管“形状”：字段类型对不对。块 id 认不认识、比例越界、栏数、drawer 不是 left / right 这些按值修正的规则在
// src/kit/components/DeskLayout/layout-model.ts 的 readLayout（逐项修正，不整体作废，5.9b 第 4 点）。
import { z } from 'zod';

/** 现在的版本号；改形状时加 1，并在 layout-migrate.ts 写一个从旧版升上来的函数 */
export const LAYOUT_V = 1;

/** 一份布局（v1）。collapsed 里的块仍留在 cols 原来的位置上（放回时回原栏原位置），只是不画 */
export const layoutSchema = z.object({
  v: z.literal(LAYOUT_V),
  cols: z.array(z.object({ w: z.number(), panels: z.array(z.string()) })),
  collapsed: z.array(z.string()).optional(),
  drawer: z.string().optional(),
  locked: z.boolean().optional(),
});

export type LayoutRaw = z.infer<typeof layoutSchema>;

export interface DeskCol {
  /** 占画布宽度的比例，各栏加起来是 1 */
  readonly w: number;
  readonly panels: readonly string[];
}

/** 修正过的布局（界面只用这个） */
export interface DeskLayoutValue {
  readonly v: typeof LAYOUT_V;
  readonly cols: readonly DeskCol[];
  readonly collapsed: readonly string[];
  readonly drawer: 'left' | 'right';
  readonly locked: boolean;
}
