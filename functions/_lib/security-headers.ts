// Pages Functions 的响应管不到 _headers，安全头要在代码里自己加（架构 8.1、15.6 第 4 条）。

/**
 * 首页（/zh/、/ko/，和给首页内容的 `/`）的 CSP（16.2）。和 site/_headers 里 /zh/、/ko/ 两段一字不差，check_site 会比对。
 * 只有首页放宽三处，都是吉祥物用的 Rive（和 App 同一套）要的：'wasm-unsafe-eval' 编译同源 wasm，connect-src 'self' 取 wasm 和 .riv，
 * img-src blob: 显示 .riv 里的图。connect-src 暂不收窄到具体路径（取的都是 /s/ 下带哈希的文件，收窄要跟着构建改名，得不偿失）
 */
export const HOME_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; " +
  "base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none'";

/** 官网其他页（演示、隐私说明、条款：/zh/:page、/ko/:page）的 CSP，不放宽。和 site/_headers 那两段一字不差 */
export const SITE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'none'; " +
  "base-uri 'none'; form-action 'self'; object-src 'none'; frame-ancestors 'none'";

/** 首页用不到任何设备能力，全部关掉 */
export const SITE_PERMISSIONS_POLICY =
  'camera=(), geolocation=(), microphone=(), accelerometer=(), gyroscope=(), magnetometer=(), payment=(), usb=()';

/** `/` 的分流响应（302 和给爬虫的 200）都加这一套；200 给的是首页内容，所以用首页的 CSP */
export function applySiteSecurityHeaders(h: Headers): void {
  h.set('Content-Security-Policy', HOME_CSP);
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', SITE_PERMISSIONS_POLICY);
}

/**
 * `/sb/*` 的每个响应都加（含本地生成的 426、404、502）：
 * 防止有人把上传的文件当成网页打开（8.1）。上游的 Content-Type 原样保留，不在这里改。
 */
export const SB_CSP = "sandbox; default-src 'none'";

export function applySbSecurityHeaders(h: Headers): void {
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('Content-Security-Policy', SB_CSP);
  h.set('Referrer-Policy', 'no-referrer');
}

/**
 * `/files/*`（0.32，14.2 第 11 点）的每个响应都加：和 /sb 同样的 nosniff、`CSP: sandbox`、no-referrer，
 * 另加 `Cache-Control: private, no-store`（签名链接取到的图片和附件不进 CDN 和浏览器缓存）。
 */
export function applyFilesSecurityHeaders(h: Headers): void {
  applySbSecurityHeaders(h);
  h.set('Cache-Control', 'private, no-store');
}
