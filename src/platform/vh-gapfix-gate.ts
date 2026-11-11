// R-371 Gap fix 默认开（11-11 主持人定；负责人 iPhone 主屏幕版 preview.250 真机通过：冷启动 895→956、底栏 853→914，切页不变）：
// 冷启动时要不要下载 vh-gapfix.ts 做一次。只在 iOS（iPhone、iPad）主屏幕版做；电脑、安卓、iOS 上在浏览器里直接打开都不下载。
// 诊断页的“Gap fix”开关改成“关掉用来对照”：关掉时存 OFF_KEY = '1'，下次冷启动起不做；没存就是开着（默认）。
// main.tsx 静态引用本文件（在首屏里），所以单独一个小文件；vh-gapfix.ts 本体只在要做时才下载
import { isAppleMobile, isStandalone, type NavLike } from './env.ts';

export const OFF_KEY = 'lemo-gapfix-off';

/** 这次冷启动要不要做 Gap fix：iOS、主屏幕版、诊断页没关掉。读不到本机存储时照默认做 */
export function gapFixWanted(nav: NavLike = navigator, media?: (q: string) => boolean, store?: Storage): boolean {
  if (!isAppleMobile(nav) || !isStandalone(nav, media)) return false;
  try {
    return (store ?? localStorage).getItem(OFF_KEY) !== '1';
  } catch {
    return true;
  }
}
