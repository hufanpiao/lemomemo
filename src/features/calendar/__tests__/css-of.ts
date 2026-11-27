// 测试里拿 CSS module 的类名（vitest 下 css modules 照常生成类名）。
// 11-17 日历整块评审把 CalendarPage.module.css 拆成几份（各组件只引自己的），这里合在一起给测试查；几份之间没有同名的类
import common from '../ui/cal-common.module.css';
import page from '../ui/CalendarPage.module.css';
import day from '../ui/DayList.module.css';
import desk from '../ui/DeskWeek.module.css';
import month from '../ui/MonthGrid.module.css';
import picker from '../ui/MonthPicker.module.css';
import week from '../ui/WeekView.module.css';

// vitest 下 module 的默认导出没有可枚举的键（展开是空对象），按名字逐份去查
const all: readonly Readonly<Record<string, string>>[] = [common, page, day, desk, month, picker, week];

export const styles: Readonly<Record<string, string>> = new Proxy({} as Record<string, string>, {
  get: (_t, k) => (typeof k === 'string' ? all.map((m) => m[k]).find((v) => v !== undefined) : undefined),
});
