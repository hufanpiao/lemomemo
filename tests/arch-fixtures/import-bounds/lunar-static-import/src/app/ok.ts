// 对照样例（LUNAR）：按需 import() 和只引类型都放行；名字里带 lunar 的别的模块不管
import type { LunarDate } from '../../../shared/logic/anniv/lunar.ts';
import { lunarSomething } from '../../../shared/logic/calendar/lunar-ui.ts';
// import { toLunar } from '../../../shared/logic/anniv/lunar.ts';   注释里的不算
export async function load(): Promise<LunarDate | null> {
  const lunar = await import('../../../shared/logic/anniv/lunar.ts');
  void lunarSomething;
  return lunar.toLunar('2026-10-24', 'cn');
}
