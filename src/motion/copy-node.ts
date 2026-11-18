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

function copy(n: Node, skip: ReadonlySet<string>, o: CopyOptions, tag?: string): Node {
  if (!(n instanceof Element)) return n.cloneNode(false);
  if (HEAVY.has(n.localName)) return placeholder(n);
  const el = tag ? document.createElement(tag) : document.createElementNS(n.namespaceURI, n.localName);
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
