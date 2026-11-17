// 页面的语言和标题跟着界面语言走（B1 韩文审校 K-16，负责人定于明早清单第 48 条，11-03）：
// <html lang> 写界面语言；document.title 用公共词典的 app.name（中文“柠檬记”、韩文“레모”），
// Safari 标签页、分享菜单里的页面名随之变。主屏幕名不在这里：apple-mobile-web-app-title 和 manifest 的 short_name
// 按 ADR-013 第 6 条（R-88）只有一个“Lemo”，不随语言变。主 App、登录页入口和设置里切换语言三处共用。
// 公共词典按语言懒加载（首屏瘦身 D，11-17；照今天页暖心句 useCheerText 的做法：按语言 import()、下载好的记在一处）：
// • loadSharedDict(locale) 只下载那一种语言的 shared/i18n/zh.ts 或 ko.ts，放进 shared/i18n/i18n.ts 的 sharedT（useT、fmt、这里的标题都查它）；
// • 同样是这三处用：入口（app/main.tsx、auth/main.tsx）渲染之前、设置里切换语言（features/settings 的 useLocaleSwitch）改 locale 之前先等它，
//   所以界面拿到的语言一定已经下载好：首屏不出空白，切换期间照旧显示原来的语言，不出键名
import { hasSharedDict, provideSharedDict, sharedT as t, type Locale } from '../../shared/i18n/i18n.ts';

export function applyDocLocale(ui: Locale): void {
  document.documentElement.lang = ui;
  document.title = t('app.name', {}, ui);
}

const loading = new Map<Locale, Promise<void>>();

/**
 * 下载这种语言的公共词典。已经下载好时回 null（调用方当场接着做，不多等一拍）；
 * 下载失败时 reject（调用方决定：入口照样渲染，sharedT 用另一份或回键名；切换语言就不换、提示失败），下次再调重新下载
 */
export function loadSharedDict(locale: Locale): Promise<void> | null {
  if (hasSharedDict(locale)) return null;
  let p = loading.get(locale);
  if (!p) {
    const dict = locale === 'ko-KR' ? import('../../shared/i18n/ko.ts').then((m) => m.ko) : import('../../shared/i18n/zh.ts').then((m) => m.zh);
    p = dict.then(
      (d) => provideSharedDict(locale, d),
      (e: unknown) => {
        loading.delete(locale);
        throw e;
      },
    );
    loading.set(locale, p);
  }
  return p;
}
