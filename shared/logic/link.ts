// 链接协议检查（架构 5.9 地点 / 链接、2.3 A26、9 单元测试；TC-B1-32）
// 一律用 new URL() 解析后看 url.protocol，不用字符串前缀判断：浏览器会忽略 `java\tscript:` 里的制表符、换行
// 和开头的控制字符，前缀判断拦不住（第七轮）。解析失败、协议不在白名单里的，调用方当普通文字显示。
// shared 的 lib 里没有 DOM 类型；浏览器、Workers、Deno、Node 都有全局 URL，这里只声明用到的部分
// （用 declare 声明，不经 globalThis 取：复制到 supabase/functions/_shared/gen 后 check_backend F7 不准把 globalThis 存进变量）

interface ParsedUrl {
  readonly protocol: string;
  readonly href: string;
  readonly username: string;
  readonly password: string;
}

declare const URL: new (input: string) => ParsedUrl;

/** 只放行这四种协议（url.protocol 带冒号、已是小写） */
const ALLOWED = new Set(['http:', 'https:', 'tel:', 'mailto:']);

/**
 * 能安全放进 href 的链接：解析成功、协议是 http、https、tel、mailto、且不带用户名和密码时返回解析后的 href，否则返回 undefined。
 * 返回 undefined 是为了能直接写 `href={safeHref(text)}`（A26 只认这个调用）；拒绝时 React 不渲染 href。
 */
export function safeHref(text: string): string | undefined {
  let url: ParsedUrl;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (!ALLOWED.has(url.protocol)) return undefined;
  // 带用户名或密码的一律拒（https://lemomemo.com@evil.com 看着像自家站，实际去 evil.com；主持人定）
  if (url.username !== '' || url.password !== '') return undefined;
  return url.href;
}
