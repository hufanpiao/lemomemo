// 设置二级页、三级页的进出（按返回栈）：navigateSub、backOrReplace。
// 不放 router.ts、不进首屏：只有懒加载的页面用；返回栈仍由 router.ts 管
import { goBack, hrefOf, navigate, stackOf, upTo, type RouteName } from './router.ts';

/** 从上一层点进子页：把上一层压进返回栈（同 navigate；快速连点由 goHref 的回调挡掉） */
export const navigateSub = navigate;

/**
 * 子页的“‹ 返回”（设置的二级页、三级页）：回到上一层 name/params。
 * 返回栈顶就是上一层（是从它点进来的）：退一步，和左边缘往右划同一条路；
 * 不是（直接打开、被原地换过、从别处跳进来）：原地换成上一层，不多压、不跳层
 */
export function backOrReplace(name: RouteName, ...params: string[]): void {
  const s = stackOf();
  if (s[s.length - 1] === hrefOf(name, ...params)) goBack();
  else void upTo(name, ...params);
}
