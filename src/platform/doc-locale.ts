// 页面的语言和标题跟着界面语言走（B1 韩文审校 K-16，负责人定于明早清单第 48 条，11-03）：
// <html lang> 写界面语言；document.title 用公共词典的 app.name（中文“柠檬记”、韩文“레모”），
// Safari 标签页、分享菜单里的页面名随之变。主屏幕名不在这里：apple-mobile-web-app-title 和 manifest 的 short_name
// 按 ADR-013 第 6 条（R-88）只有一个“Lemo”，不随语言变。主 App、登录页入口和设置里切换语言三处共用。
import { t, type Locale } from '../../shared/i18n/i18n.ts';

export function applyDocLocale(ui: Locale): void {
  document.documentElement.lang = ui;
  document.title = t('app.name', {}, ui);
}
