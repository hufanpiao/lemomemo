// 底栏四个页签和从左到右的顺序：底栏照它画，页签互切往哪边滑也按它（app/tab-of.ts 的 tabDir）。
// 单放一个文件：只要顺序的地方（路由的方向判断、它的测试）不用把底栏组件整个引进来
export type TabName = 'today' | 'calendar' | 'todos' | 'notes';
export const TAB_ORDER: readonly TabName[] = ['today', 'calendar', 'todos', 'notes'];
