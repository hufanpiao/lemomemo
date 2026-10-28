// 直接 fetch 的统一封装（架构 0.27 第 1 点）：和 supabase-js 一样带 X-App-Version
// fetch 只准出现在 platform（A12）；功能要直接调函数时走这里，不自己 fetch
import { buildInfo } from '../app/build-info.ts';

export const APP_VERSION_HEADER = 'X-App-Version';

/** 给请求头补上 X-App-Version（调用方传了同名头时以本函数为准，不让人改版本号） */
export function withAppVersion(init: HeadersInit | undefined, version: string = buildInfo.version): Headers {
  const h = new Headers(init);
  h.set(APP_VERSION_HEADER, version);
  return h;
}

/** 带版本头的 fetch；supabase-js 的 global.fetch 也用它 */
export function appFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = withAppVersion(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  return fetch(input, { ...init, headers });
}
