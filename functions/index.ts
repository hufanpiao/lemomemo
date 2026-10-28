// `/` 的语言分流（架构 16.1、16.4，R-75）。只处理 `/` 这一个路径（site/_routes.json 让 `/`、`/files/*`、`/sb/*` 进 Functions；
// `/files/*` 由 functions/files/[[path]].ts、`/sb/*` 由 functions/sb/[[path]].ts 处理，都不经这里）。
// 依次：cookie lemo_lang → 搜索引擎直接给 200 中文版（x-default）→ Accept-Language → 默认中文。
// `/zh/`、`/ko/` 是固定网址，由 Pages 直接给静态文件，永不自动跳转。

import { localeFromCookieHeader, parseAcceptLanguage, pickLocale, type Locale } from '../shared/i18n/pick-locale.ts';
import { applySiteSecurityHeaders } from './_lib/security-headers.ts';

/** 爬虫和链接预览：不跳转，直接拿到中文版内容（16.4 第 3 条） */
const CRAWLER_RE =
  /googlebot|google-inspectiontool|storebot-google|adsbot-google|mediapartners-google|bingbot|bingpreview|yeti|daumoa|baiduspider|duckduckbot|yandex|applebot|sogou|360spider|petalbot|facebookexternalhit|facebot|twitterbot|linkedinbot|slackbot|discordbot|telegrambot|kakaotalk-scrap|naver/i;

export function isCrawler(userAgent: string | null, acceptLanguage: string | null): boolean {
  if (!acceptLanguage || !acceptLanguage.trim()) return true;
  return !!userAgent && CRAWLER_RE.test(userAgent);
}

export interface RootDeps {
  /** 取静态文件（Pages 的 env.ASSETS.fetch） */
  fetchAsset: (path: string) => Promise<Response>;
}

function baseHeaders(): Headers {
  const h = new Headers();
  applySiteSecurityHeaders(h);
  // 一个人的跳转结果不能被 CDN 缓存给别人；结果还取决于 UA（爬虫），一并写进 Vary
  h.set('Vary', 'Accept-Language, Cookie, User-Agent');
  h.set('Cache-Control', 'private, no-store');
  return h;
}

function redirectTo(url: URL, locale: Locale): Response {
  const h = baseHeaders();
  const target = new URL(`/${locale}/`, url);
  target.search = url.search; // 带着 utm 一类查询串走
  h.set('Location', target.toString());
  return new Response(null, { status: 302, headers: h });
}

export async function handleRoot(request: Request, deps: RootDeps): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    const h = baseHeaders();
    h.set('Allow', 'GET, HEAD');
    return new Response(null, { status: 405, headers: h });
  }
  const url = new URL(request.url);
  const saved = localeFromCookieHeader(request.headers.get('Cookie'));
  const al = request.headers.get('Accept-Language');

  if (!saved && isCrawler(request.headers.get('User-Agent'), al)) {
    // 200 + 中文版（x-default），页面里本来就带完整的 hreflang
    let asset: Response | null = null;
    try {
      asset = await deps.fetchAsset('/zh/');
    } catch {
      asset = null;
    }
    if (!asset || !asset.ok) return redirectTo(url, 'zh');
    const h = baseHeaders();
    h.set('Content-Type', 'text/html; charset=utf-8');
    const body = method === 'HEAD' ? null : await asset.text();
    return new Response(body, { status: 200, headers: h });
  }

  return redirectTo(url, pickLocale(saved, parseAcceptLanguage(al)));
}

interface Env {
  ASSETS: { fetch: (input: Request | string | URL) => Promise<Response> };
}

export const onRequest: PagesFunction<Env> = (ctx) =>
  handleRoot(ctx.request, {
    fetchAsset: (path) => ctx.env.ASSETS.fetch(new URL(path, ctx.request.url)),
  });
