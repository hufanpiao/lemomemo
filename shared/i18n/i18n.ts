// 词典查找 t()（架构 2.4）：键名、参数都有类型——写错键名、少传参数都编译不过
// 只返回字符串，不碰 DOM。pickLocale（16.4）由前端 B 加在这里或同目录，前端 A 这边不写
import { ko } from './ko.ts';
import { zh } from './zh.ts';

export type Locale = 'zh-CN' | 'ko-KR';
export const LOCALES: readonly Locale[] = ['zh-CN', 'ko-KR'];

export type SharedMsgKey = keyof typeof zh;
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
    const v = params[name];
    return v === undefined ? all : String(v);
  });
}

/**
 * 按一对中韩词典造一个 t()。功能自己的词典（src/features/<功能>/i18n/）也用它。
 * 韩文词典缺键时退回中文（类型上不会缺，这里防的是运行时拼出来的键）。
 */
export function createT<D extends Dict>(dicts: { zh: D; ko: Readonly<Record<keyof D, string>> }) {
  return function t<K extends keyof D & string>(key: K, params: ParamsOf<D, K>, locale: Locale): string {
    const src: Readonly<Record<string, string | undefined>> = locale === 'ko-KR' ? dicts.ko : dicts.zh;
    const zhSrc: Readonly<Record<string, string | undefined>> = dicts.zh;
    const tpl = src[key] ?? zhSrc[key] ?? key;
    return fill(tpl, params);
  };
}

/** 公共词典的 t */
export const t = createT({ zh, ko });

/** 词条里的占位符名（测试用：中韩两边必须一致） */
export function placeholdersOf(tpl: string): string[] {
  return [...tpl.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();
}
