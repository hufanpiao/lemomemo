/* global document, window, URL */
// 机型信息页（R-232，iPhone 实机验收清单 P1-07 第 1、2 步）：只显示技术信息，不读也不显示任何用户数据。
// 12 条 media 不在这里另抄一份：运行时请求服务器上当前部署的 /app/index.html?diag=1 现场解析，
// 改了 index.html 不用同步这里；解析函数 parseStartupLinks 由 src/app/__tests__/startup-diag.test.ts 拿 src/index.html 核对。
// 为什么带 ?diag=1：SW 的 precacheAndRoute（src/sw/sw.ts）没配 ignoreURLParametersMatching，用 Workbox 默认值，
// 只去掉 utm_ 开头和 fbclid 参数；带着 diag=1 的地址和预缓存清单里的 /app/index.html 对不上，也没有别的 SW 路由接它，
// 所以一定走网络，读到的是服务器上现在的那份，不会是这台设备 SW 预缓存里的旧版。
// 注意：这只能说明“现在部署的是什么”；iOS 实际用的是添加到主屏幕那一刻读到的那份（改图后要不要重加，见 P1-07 第 5 步）。
export const DIAG_PARAM = 'diag';

const LINK_TAG = /<link\b[^>]*>/gi;
const ATTR = (name) => new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i');

/** 从 index.html 文本里取出全部 apple-touch-startup-image 的 {media, href}，按出现顺序 */
export function parseStartupLinks(html) {
  const out = [];
  for (const [tag] of html.matchAll(LINK_TAG)) {
    if (ATTR('rel').exec(tag)?.[1]?.trim().toLowerCase() !== 'apple-touch-startup-image') continue;
    out.push({ media: ATTR('media').exec(tag)?.[1] ?? '', href: ATTR('href').exec(tag)?.[1] ?? '' });
  }
  return out;
}

/** 从文件名 startup-<宽>x<高>.png 取像素尺寸 */
export function pixelSize(href) {
  const m = /startup-(\d+)x(\d+)\.png$/.exec(href);
  return m ? `${m[1]}×${m[2]}` : '（文件名里没有尺寸）';
}

/** 首页地址：本页在 /app/diag/ 下，首页是上一级的 index.html；带 ?diag=1 绕开 SW 预缓存（见文件开头） */
export function indexUrl(pageUrl) {
  const u = new URL('../index.html', pageUrl);
  u.searchParams.set(DIAG_PARAM, '1');
  return u.href;
}

function row(dl, doc, k, v) {
  const dt = doc.createElement('dt');
  dt.textContent = k;
  const dd = doc.createElement('dd');
  dd.textContent = v;
  dl.append(dt, dd);
}

/** 填页面；doc、win 由调用方给（测试里给 jsdom 的） */
export async function run(doc, win) {
  const scr = win.screen;
  const mm = (q) => win.matchMedia(q).matches;
  const dl = doc.getElementById('device');
  row(dl, doc, 'screen.width × height', `${scr.width} × ${scr.height}`);
  row(dl, doc, 'devicePixelRatio', String(win.devicePixelRatio));
  row(dl, doc, '物理像素（按上面相乘）', `${Math.round(scr.width * win.devicePixelRatio)} × ${Math.round(scr.height * win.devicePixelRatio)}`);
  row(dl, doc, '当前方向', mm('(orientation: portrait)') ? '竖屏（portrait）' : '横屏（landscape）');
  row(dl, doc, '深色模式', mm('(prefers-color-scheme: dark)') ? '是（dark）' : '否（light）');
  row(dl, doc, '主屏幕版打开', win.navigator.standalone === true ? '是' : '否（浏览器里打开）');
  row(dl, doc, '系统（User-Agent）', win.navigator.userAgent);

  const result = doc.getElementById('result');
  const list = doc.getElementById('links');
  const src = indexUrl(win.location.href);
  doc.getElementById('source').textContent = `media 来源：${src}（运行时读服务器上当前部署的那份，绕开 SW 预缓存，不另抄）`;
  let links;
  try {
    const res = await win.fetch(src, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    links = parseStartupLinks(await res.text());
  } catch (e) {
    result.textContent = `读不到首页，无法判断（${e instanceof Error ? e.message : String(e)}）；请联网后刷新`;
    return;
  }
  let first = null;
  for (const [i, l] of links.entries()) {
    const hit = mm(l.media);
    if (hit && !first) first = l;
    const li = doc.createElement('li');
    li.textContent = `${hit ? '✔ 匹配' : '✘'}  ·  ${l.href.split('/').pop()}（${pixelSize(l.href)}）  ·  ${l.media}`;
    if (hit) li.className = 'hit';
    li.dataset.index = String(i);
    list.append(li);
  }
  result.textContent = first
    ? `${first.href.split('/').pop()}（${pixelSize(first.href)} 像素）`
    : `读到的 ${links.length} 条都没匹配上：添加到主屏幕后会退回 manifest 的 background_color 纯色`;
}

if (typeof document !== 'undefined' && document.getElementById('startup-diag')) {
  void run(document, window);
}
