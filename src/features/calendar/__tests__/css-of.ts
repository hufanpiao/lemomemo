// 测试里拿 CSS module 的类名（vitest 下 css modules 照常生成类名）
import css from '../ui/CalendarPage.module.css';

export const styles: Readonly<Record<string, string>> = css;
