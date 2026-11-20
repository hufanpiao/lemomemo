// 词典查找 t()（架构 2.4）：键名、参数都有类型——写错键名、少传参数都编译不过。只返回字符串，不碰 DOM；界面语言怎么定在 pick-locale.ts
// 查找顺序：要的那种语言 → 另一种 → 键名（createT）；sharedT 在“要的那种语言”里多查一层启动兜底（boot-zh.ts、boot-ko.ts），见 sharedT
// 公共词典有两种取法（首屏瘦身 D，11-17）：
// • t（t-static.ts）：中韩两份静态带上，给服务器（push-dispatch）、SW、测试用；
// • sharedT（这里）：网页用，只查已经下载好的那份。下载由 src/platform/doc-locale.ts 管（入口按当前语言下载一份，失败改下另一份），
//   下载好了经 provideSharedDict 放进来并通知订阅者（kit 的 useT 用 useSyncExternalStore 订阅，晚到时用到它的组件跟着重画）；
//   两份都没下载到时，App 名、退出屏、出错屏、升级整屏提示照样有字（启动兜底），别的词条才回键名
// 这份文件只许 import type 整份词典：一静态引 zh.ts、ko.ts，两份就都进了网页首屏
import { createSignal } from '../core/signal.ts';
import { bootKo } from './boot-ko.ts';
import { bootZh } from './boot-zh.ts';
import type { UiLocale } from './pick-locale.ts';
import type { zh } from './zh.ts';

/** 界面语言：就是 pick-locale.ts 的 UiLocale（同一个类型，只是在词典这边叫 Locale） */
export type Locale = UiLocale;

export type SharedDict = typeof zh;
export type SharedMsgKey = keyof SharedDict;
export type Dict = Readonly<Record<string, string>>;

/** 从 '{time} {title}' 推出 'time' | 'title' */
export type ParamNames<S extends string> = S extends `${string}{${infer P}}${infer R}` ? P | ParamNames<R> : never;

/** 词条 K 需要的参数；没有占位符时是空对象 */
export type ParamsOf<D extends Dict, K extends keyof D> = [ParamNames<D[K] & string>] extends [never]
  ? Record<string, never>
  : Record<ParamNames<D[K] & string>, string | number>;

/** 把 {name} 换成参数；参数里没有的占位符原样留着（开发时一眼能看出来） */
export function fill(tpl: string, params: Readonly<Record<string, string | number>>): string {
  return tpl.replace(/\{(\w+)\}/g, (all, name: string) => {
    const v = Object.hasOwn(params, name) ? params[name] : undefined;   // 只取自有属性（check_backend F7）
    return v === undefined ? all : String(v);
  });
}

/** 另一种界面语言 */
export function otherLocale(locale: Locale): Locale {
  return locale === 'ko-KR' ? 'zh-CN' : 'ko-KR';
}

type Lookup = Readonly<Record<string, string | undefined>> | undefined;
type Pair = Readonly<{ zh?: Lookup; ko?: Lookup }>;

function pick(src: Lookup, key: string): string | undefined {
  if (!src) return undefined;
  return Object.hasOwn(src, key) ? src[key] : undefined;   // 只取自有属性（check_backend F7）
}

/** 一种语言里查 */
const inOne = (dicts: Pair, key: string, l: Locale): string | undefined => pick(l === 'ko-KR' ? dicts.ko : dicts.zh, key);

/** 要的那种语言 → 另一种（韩文词典缺键、懒加载的那份还没到都退到另一份）；都没有回 undefined */
function lookup(dicts: Pair, key: string, locale: Locale): string | undefined {
  return inOne(dicts, key, locale) ?? inOne(dicts, key, otherLocale(locale));
}

const BOOT: Pair = { zh: bootZh, ko: bootKo };

/** 按一对中韩词典造一个 t()。功能自己的词典（src/features/<功能>/i18n/）也用它；查找顺序见文件头 */
export function createT<D extends Dict>(dicts: { zh?: D; ko?: Readonly<Record<keyof D, string>> }) {
  return function t<K extends keyof D & string>(key: K, params: ParamsOf<D, K>, locale: Locale): string {
    return fill(lookup(dicts, key, locale) ?? key, params);
  };
}

/** 网页里已经下载好的公共词典。每放进一份就换一个新对象（useSyncExternalStore 的快照按引用比较） */
let loadedShared: Readonly<{ zh?: SharedDict; ko?: Readonly<Record<SharedMsgKey, string>> }> = {};
const listeners = createSignal();

/** 放进一份下载好的公共词典（src/platform/doc-locale.ts 的 loadSharedDict、测试的公共准备），并通知订阅者 */
export function provideSharedDict(locale: Locale, dict: Readonly<Record<SharedMsgKey, string>>): void {
  loadedShared = locale === 'ko-KR' ? { ...loadedShared, ko: dict } : { ...loadedShared, zh: dict as SharedDict };
  listeners.emit();
}

/** 订阅“又下载好了一份公共词典”（kit 的 useT）；返回退订函数 */
export const subscribeSharedDict = listeners.subscribe;

/** 现在下载好的公共词典（useSyncExternalStore 的快照：没变就是同一个对象） */
export function sharedDictSnapshot(): object {
  return loadedShared;
}

/** 这种语言的公共词典下载好了没有 */
export function hasSharedDict(locale: Locale): boolean {
  return (locale === 'ko-KR' ? loadedShared.ko : loadedShared.zh) !== undefined;
}

/** 测试用：清掉已经下载好的公共词典（测“一份都没有”“只有一份”） */
export function resetSharedDictsForTest(): void {
  loadedShared = {};
  listeners.emit();
}

/**
 * 网页用的公共词典 t（见文件头）：要的那种语言（下载好的整份 → 同语言的启动兜底）→ 另一种下载好的 → 键名。
 * 启动兜底排在另一种前面：App 名、退出屏这几条两种语言都静态带着，要韩文就给韩文，不因为只下载到中文而显示中文
 */
export function sharedT<K extends SharedMsgKey & string>(key: K, params: ParamsOf<SharedDict, K>, locale: Locale): string {
  const tpl = inOne(loadedShared, key, locale) ?? inOne(BOOT, key, locale) ?? inOne(loadedShared, key, otherLocale(locale)) ?? key;
  return fill(tpl, params);
}

/** 词条里的占位符名（测试用：中韩两边必须一致） */
export function placeholdersOf(tpl: string): string[] {
  return [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
}
