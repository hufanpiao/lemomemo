// 底栏四个页签从左到右的顺序：底栏照它画，横滑切页按它（app/tab-swipe.ts）。
// 单放一个文件：只要顺序的地方（横滑切页、它的测试）不用把底栏组件整个引进来。页签名本身跟路由层级表放在 app/router.ts
import type { TabName } from '../../../app/router.ts';

export type { TabName };
export const TAB_ORDER: readonly TabName[] = ['today', 'calendar', 'todos', 'notes'];
