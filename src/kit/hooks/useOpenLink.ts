// 链接的点击处理（R-301；B6-exe 安全审查 F5-5）：exe 里用户亲手点了才交给系统浏览器（platform 的 openExternal → Rust 的 open_external），
// 不靠 target=_blank、不靠页面跳转；网页版不拦，照浏览器默认走。kit 的组件经这里碰 platform（kit 组件不直接引 platform）
import type { MouseEvent } from 'react';
import { openExternal, openSitePage } from '../../platform/native-bridge.ts';

/** 给 <a onClick> 用：href 是已经过 safeHref 的地址 */
export function linkClickHandler(href: string): (e: MouseEvent<HTMLAnchorElement>) => void {
  return (e) => {
    if (openExternal(href)) e.preventDefault();
  };
}

/** 给本站页面的 <a onClick> 用（href 是 /zh/privacy 这类相对地址常量）：exe 里拼成绝对地址交给系统浏览器，网页版照原样新窗口打开 */
export function sitePageClickHandler(path: string): (e: MouseEvent<HTMLAnchorElement>) => void {
  return (e) => {
    if (openSitePage(path)) e.preventDefault();
  };
}
