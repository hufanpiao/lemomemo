// 词典查找 t()（架构 2.4）：键名、参数都有类型——写错键名、少传参数都编译不过
// 只返回字符串，不碰 DOM。pickLocale（16.4）由前端 B 加在这里或同目录，前端 A 这边不写
// 公共词典有两种取法（首屏瘦身 D，11-17）：
// • t（t-static.ts）：中韩两份静态带上，给服务器（push-dispatch）、SW、测试用；
// • sharedT（这里）：网页用，只查已经下载好的那份（provideSharedDict 放进来；src/platform/doc-locale.ts 的 loadSharedDict 按当前语言只下载一份，
//   入口渲染前、切换语言前先等它）。要的那份没有就用另一份，两份都没有才回键名。
// 这份文件只许 import type 词典：一静态引 zh.ts、ko.ts，两份就都进了网页首屏
import type { zh } from './zh.ts';

export type Locale = 'zh-CN' | 'ko-KR';
export const LOCALES: readonly Locale[] = ['zh-CN', 'ko-KR'];

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

type Lookup = Readonly<Record<string, string | undefined>> | undefined;
function pick(src: Lookup, key: string): string | undefined {
  if (!src) return undefined;
  return Object.hasOwn(src, key) ? src[key] : undefined;   // 只取自有属性（check_backend F7）
}

/**
 * 按一对中韩词典造一个 t()。功能自己的词典（src/features/<功能>/i18n/）也用它。
 * 先查要的那种语言，没有再查中文、再查韩文，都没有回键名：韩文词典缺键（运行时拼出来的键）退回中文；
 * 词典是按语言懒加载的（sharedT）时，某一份还没下载就用另一份
 */
export function createT<D extends Dict>(dicts: { zh?: D; ko?: Readonly<Record<keyof D, string>> }) {
  return function t<K extends keyof D & string>(key: K, params: ParamsOf<D, K>, locale: Locale): string {
    const tpl = pick(locale === 'ko-KR' ? dicts.ko : dicts.zh, key) ?? pick(dicts.zh, key) ?? pick(dicts.ko, key) ?? key;
    return fill(tpl, params);
  };
}

/** 网页里已经下载好的公共词典 */
const loadedShared: { zh?: SharedDict; ko?: Readonly<Record<SharedMsgKey, string>> } = {};

/** 放进一份下载好的公共词典（src/platform/doc-locale.ts 的 loadSharedDict、测试的公共准备） */
export function provideSharedDict(locale: Locale, dict: Readonly<Record<SharedMsgKey, string>>): void {
  if (locale === 'ko-KR') loadedShared.ko = dict;
  else loadedShared.zh = dict as typeof zh;
}

/** 这种语言的公共词典下载好了没有 */
export function hasSharedDict(locale: Locale): boolean {
  return (locale === 'ko-KR' ? loadedShared.ko : loadedShared.zh) !== undefined;
}

/** 网页用的公共词典 t：只查已经下载好的（见文件头） */
export const sharedT = createT<typeof zh>(loadedShared);

/** 词条里的占位符名（测试用：中韩两边必须一致） */
export function placeholdersOf(tpl: string): string[] {
  return [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
}
