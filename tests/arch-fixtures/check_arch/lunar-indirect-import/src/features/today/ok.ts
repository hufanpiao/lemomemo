// 对照样例：动态 import()、import type、链上有 import() 或 import type 断开、无关模块、注释，都放行
import type { mid } from '../../../shared/logic/mid.ts';
import { viaLazy } from '../../../shared/logic/via-lazy.ts';
import { lazyLunar } from '../../../shared/logic/lazy.ts';
import { viaType } from '../../../shared/logic/via-type.ts';
import { clean } from '../../../shared/logic/clean.ts';
// import { nextDate } from '../../../shared/logic/anniv/next-date.ts';   注释里的不算
export async function load(): Promise<unknown> {
  const m = await import('../../../shared/logic/mid.ts');
  return [m.mid, viaLazy, lazyLunar, viaType, clean] as unknown as typeof mid;
}
