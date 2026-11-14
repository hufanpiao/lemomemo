// 电脑版布局的版本迁移（架构 5.9b 第 4 点）：读出来的 v 比现在小时，按这里的函数逐版升上来（写回时用新版本）。
// 键是旧版本号，函数把那一版的值变成下一版。v1 是第一版，现在没有迁移；以后改形状时在这里加一条、单测补一条。纯 TS
import { LAYOUT_V } from '../../../../shared/schema/layout.ts';

type Step = (raw: Record<string, unknown>) => Record<string, unknown>;

export const MIGRATIONS: Readonly<Record<number, Step>> = {};

/** 把旧版本升到现在的版本；中间缺一步（不该发生）返回 null，当坏值处理 */
export function migrateLayout(raw: Record<string, unknown>, steps: Readonly<Record<number, Step>> = MIGRATIONS): Record<string, unknown> | null {
  let cur = raw;
  let v = cur['v'];
  while (typeof v === 'number' && v < LAYOUT_V) {
    const step = steps[v];
    if (!step) return null;
    cur = step(cur);
    const next: unknown = cur['v'];
    if (typeof next !== 'number' || next <= v) return null;
    v = next;
  }
  return cur;
}
