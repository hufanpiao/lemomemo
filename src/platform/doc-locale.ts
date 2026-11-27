// 界面语言从“定下来”到“用上”只有这一份，入口和设置不各写各的：
// • bootLocale：profiles.ui_locale（缓存，没有传 null）→ 本机选过的 pv-locale → 设备语言 → 中文
// • applyUiLocale：ui-store 的 locale（调用方传进来：platform 引不到 kit）、<html lang>、document.title。
//   主屏幕名不在这里：apple-mobile-web-app-title 和 manifest 的 short_name 只有一个“Lemo”
// • 公共词典按语言懒加载：loadSharedDict 只下载一种语言；ensureSharedDict 给入口用，失败就改下另一种，再失败也放行（不挡启动），
//   两份都没有时走启动兜底（boot-zh.ts、boot-ko.ts），不出键名。入口只在第一次画东西之前等它；设置里切换语言失败就不换
import { fromUiLocale, LOCALE_STORAGE_KEY, pickLocale, toUiLocale, type UiLocale } from '../../shared/i18n/pick-locale.ts';
import { hasSharedDict, otherLocale, provideSharedDict, sharedT as t } from '../../shared/i18n/i18n.ts';

/** 定界面语言（规则见文件头）；profileUi 是缓存的 profiles.ui_locale（不是 'zh-CN' / 'ko-KR' 当没有） */
export function bootLocale(profileUi: unknown = null): UiLocale {
  let saved: string | null;
  try {
    saved = localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    saved = null;   // 隐私模式读不到：按设备语言
  }
  return toUiLocale(pickLocale(fromUiLocale(typeof profileUi === 'string' ? profileUi : null) ?? saved, navigator.languages));
}

/** ui-store 里管语言的那一个方法（由调用方传 uiStore.getState()） */
export interface LocaleStore {
  setLocale(locale: UiLocale): void;
}

/** 用上界面语言：ui-store、<html lang>、页面标题 */
export function applyUiLocale(ui: UiLocale, store: LocaleStore): void {
  store.setLocale(ui);
  document.documentElement.lang = ui;
  document.title = t('app.name', {}, ui);
}

const loading = new Map<UiLocale, Promise<void>>();

/**
 * 下载这种语言的公共词典。已经下载好时回 null（调用方当场接着做，不多等一拍）；同一种语言正在下载时回同一个 Promise；
 * 下载失败时 reject，下次再调重新下载
 */
export function loadSharedDict(locale: UiLocale): Promise<void> | null {
  if (hasSharedDict(locale)) return null;
  let p = loading.get(locale);
  if (!p) {
    const dict = locale === 'ko-KR' ? import('../../shared/i18n/ko.ts').then((m) => m.ko) : import('../../shared/i18n/zh.ts').then((m) => m.zh);
    p = dict.then((d) => provideSharedDict(locale, d)).finally(() => loading.delete(locale));
    loading.set(locale, p);
  }
  return p;
}

/**
 * 入口用：下载这种语言的公共词典，失败改下另一种，两种都失败也照样 resolve（不挡启动）；每次失败记一行（log 由入口给：主 App 记运行日志）
 */
export async function ensureSharedDict(locale: UiLocale, log: (line: string) => void = () => undefined): Promise<void> {
  for (const l of [locale, otherLocale(locale)]) {
    try {
      await loadSharedDict(l);
      return;
    } catch {
      log(`i18n err=load locale=${l}`);
    }
  }
}
