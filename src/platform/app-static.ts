// 拉 App 自带的公共静态 JSON（B2 FA-3：节假日 holidays/<国>/<年>.json，5.4、5.12 第 3 点）
// • 地址相对 App 根目录（/app/），按 document.baseURI 拼；只认同源，拼出别的源就不拉
// • 不带令牌、不带 Cookie 以外的东西（credentials: 'same-origin' 是浏览器默认）；SW 对 /app/holidays/ 走“先联网、失败用缓存”
// • fetchAppJsonStatus 分清“没有”（4xx、不是 JSON）和“没拉到”（断网、5xx）；fetchAppJson 拿不到一律返回 null，不抛错
// 功能层不准直接 fetch（架构 A 规则），经这里拉

/** 相对路径只许字母、数字、/、_、-、.（不许 ..、//、\、?、#） */
const PATH_RE = /^(?!.*\.\.)(?!\/)(?!.*\/\/)[A-Za-z0-9/_.-]+\.json$/;

/** 相对路径 → 同源的绝对地址；不合规、拼出别的源返回 null */
export function appStaticUrl(path: string, base: string = document.baseURI): string | null {
  if (!PATH_RE.test(path)) return null;
  try {
    const b = new URL(base);
    const u = new URL(path, b);
    return u.origin === b.origin ? u.href : null;
  } catch {
    return null;
  }
}

/**
 * 拉的结果分三种（B2 代码审查 M2、安全审查 FA3-4）：
 * • ok：拿到了 JSON；
 * • missing：服务器明确说没有（4xx，含 404）、或者拿到的不是 JSON、或者路径不合规——再拉也一样，调用方可以记住“没有”；
 * • failed：没拉到（断网又没缓存、超时、5xx）——不要记死，联网后再拉
 */
export type AppJson = { readonly kind: 'ok'; readonly json: unknown } | { readonly kind: 'missing' } | { readonly kind: 'failed' };

/** 拉一份 App 自带的 JSON，分清“没有”和“没拉到”；不抛错 */
export async function fetchAppJsonStatus(path: string, f: typeof fetch = fetch, base?: string): Promise<AppJson> {
  const url = appStaticUrl(path, base);
  if (url === null) return { kind: 'missing' };
  let res: Response;
  try {
    res = await f(url, { method: 'GET' });
  } catch {
    return { kind: 'failed' };
  }
  if (!res.ok) return res.status >= 400 && res.status < 500 ? { kind: 'missing' } : { kind: 'failed' };
  try {
    return { kind: 'ok', json: (await res.json()) as unknown };
  } catch {
    return { kind: 'missing' };
  }
}

/** 拉一份 App 自带的 JSON；拿不到返回 null，不抛错（不关心为什么拿不到的调用方用） */
export async function fetchAppJson(path: string, f: typeof fetch = fetch, base?: string): Promise<unknown> {
  const r = await fetchAppJsonStatus(path, f, base);
  return r.kind === 'ok' ? r.json : null;
}
