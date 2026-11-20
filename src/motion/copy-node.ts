// 拍一份静态副本（这类事只在这里做，架构约定 10.1）：换页的旧页快照（page-swap.ts）、拖动浮层（sort-float.ts）、日历翻页副本（swipe-pager.ts）共用。
// 11-18 评审第 6、9 条：原来三处各写一份，后两处用 cloneNode(true)，连 style 属性一起抄、被页面 CSP（style-src-attr）拦（e2e 11-18 实测 securitypolicyviolation）。
// • 不用 cloneNode(true)：逐个元素新建、抄属性；内联样式走 CSSOM 抄（CSSOM 不受 style-src-attr 限制）
// • 跳过 id、data-testid（不和真页面重名）、name（快照里的单选框会和真页面分到一组、抄 checked 时把真的取消掉）和调用方给的 strip
// • 静止的一张：CSS 动画、过渡一律停住
// • 视频、音频、画布、iframe、object、embed 不抄，换成同样大小的空占位（抄了会重新加载、解码，费手机性能，评审第 9 条）
// • 打了的字、勾的框、选的项不在属性里，单抄；滚动过的元素交给 onScrolled（放上去以后再抄滚动位置）

const BASE_SKIP = ['id', 'data-testid', 'name', 'style'];
const HEAVY = new Set(['video', 'audio', 'canvas', 'iframe', 'object', 'embed']);

export interface CopyOptions {
  /** 另外要去掉的属性 */
  strip?: readonly string[];
  /** 最外层换成这个标签（换页快照的外壳不能是 <main>：页面上 querySelector('main') 只该找到真页面） */
  tag?: string;
  /** 滚动过的元素：原来的、副本 */
  onScrolled?(from: Element, to: Element): void;
}

function copyAttrs(from: Element, to: Element, skip: ReadonlySet<string>): void {
  for (const { name, value } of from.attributes) if (!skip.has(name)) to.setAttributeNS(null, name, value);
  const src = (from as HTMLElement).style as CSSStyleDeclaration | undefined;
  const dst = (to as HTMLElement).style as CSSStyleDeclaration | undefined;
  if (!dst) return;
  if (src?.cssText) dst.cssText = src.cssText;
  dst.setProperty('animation', 'none');
  dst.setProperty('transition', 'none');
}

function placeholder(n: Element): HTMLElement {
  const r = n.getBoundingClientRect();
  const p = document.createElement('div');
  const cls = n.getAttribute('class');
  if (cls) p.setAttribute('class', cls);
  p.style.cssText = `width:${r.width}px;height:${r.height}px;animation:none;transition:none`;
  return p;
}

/** 画成画布的小图上限（CSS px，头像这一类）：大图（随手记配图）照旧抄成 <img>，免得换页时一次画很多大画布 */
const SMALL_IMG_PX = 160;

/**
 * 已经解码好的小图当场画进同样大小的画布（按 object-fit 的 cover / 拉伸画）。负责人 11-18 录屏：切页时右上角头像空约 0.83 秒，
 * 和切页时长 0.88 秒一样长——新建的 <img> 要重新加载、解码，iPhone 上整段切页都空着，钉住的副本等于没有；画布一出来就有像素。
 * 没解码好、太大、画不了的回 null，照旧抄成 <img>
 */
function paintSmall(n: HTMLImageElement, skip: ReadonlySet<string>): HTMLCanvasElement | null {
  const r = n.getBoundingClientRect();
  if (!n.complete || n.naturalWidth === 0 || r.width === 0 || r.height === 0 || r.width > SMALL_IMG_PX || r.height > SMALL_IMG_PX) return null;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const c = document.createElement('canvas');
  c.width = Math.round(r.width * dpr);
  c.height = Math.round(r.height * dpr);
  const g = c.getContext('2d');
  if (!g) return null;
  const cover = getComputedStyle(n).objectFit === 'cover';
  const s = cover ? Math.max(c.width / n.naturalWidth, c.height / n.naturalHeight) : 0;
  const sw = cover ? c.width / s : n.naturalWidth;
  const sh = cover ? c.height / s : n.naturalHeight;
  try {
    g.drawImage(n, (n.naturalWidth - sw) / 2, (n.naturalHeight - sh) / 2, sw, sh, 0, 0, c.width, c.height);
  } catch {
    return null;
  }
  copyAttrs(n, c, new Set([...skip, 'src', 'srcset', 'alt', 'loading', 'decoding']));
  c.style.setProperty('width', `${r.width}px`);
  c.style.setProperty('height', `${r.height}px`);
  c.setAttribute('aria-hidden', 'true');
  return c;
}

function copy(n: Node, skip: ReadonlySet<string>, o: CopyOptions, tag?: string): Node {
  if (!(n instanceof Element)) return n.cloneNode(false);
  if (HEAVY.has(n.localName)) return placeholder(n);
  if (n instanceof HTMLImageElement) {
    const c = paintSmall(n, skip);
    if (c) return c;
  }
  // HTML 元素照 React DOM 的建法走 createElement（WebKit 每建一个 <select> 内核都报一条 style-src-attr 误报，e2e csp-fixture 只认这条路上的；
  // 页面没有样式被拦，见 csp-fixture.ts 文件头），SVG 这类别的命名空间才用 createElementNS
  const html = n.namespaceURI === 'http://www.w3.org/1999/xhtml';
  const el = tag ? document.createElement(tag) : html ? document.createElement(n.localName) : document.createElementNS(n.namespaceURI, n.localName);
  copyAttrs(n, el, skip);
  for (const c of n.childNodes) el.append(copy(c, skip, o));
  if (n instanceof HTMLInputElement && el instanceof HTMLInputElement) {
    el.value = n.value;
    el.checked = n.checked;
  } else if ((n instanceof HTMLTextAreaElement && el instanceof HTMLTextAreaElement) || (n instanceof HTMLSelectElement && el instanceof HTMLSelectElement)) {
    el.value = n.value;
  }
  if (o.onScrolled && (n.scrollTop !== 0 || n.scrollLeft !== 0)) o.onScrolled(n, el);
  return el;
}

/** 拍 n 的静态副本（规则见文件头） */
export function copyNode<T extends Node>(n: T, o: CopyOptions = {}): T {
  return copy(n, new Set([...BASE_SKIP, ...(o.strip ?? [])]), o, o.tag) as T;
}
