// 层栈和窗口内快捷键（第三方审查前端-8、14：弹层的 Esc、还焦点原来 5 种写法，直接挂 keydown 9 处，收成这一套；11-14 层栈整块评审又删了一批特例）
// 分两个文件：这里是栈、Esc、inert、快捷键；React 的 useLayer 和还焦点在 useLayer.ts。都不进首屏（11-14 首屏 150 KB 预算实测差 0.2 KB，
//   App 的 Ctrl+N 挪到打字条预先下载的那一块里、退出整屏提示按需下载这里，首屏不再引用层栈）
// 层：盖在页面上、按 Esc 该收起的东西都算——kit Dialog、查找面板和结果层、纪念日编辑层、附件整窗浮层、详情抽屉、kit Popover、隐私记锁屏、
//   打字条、录音锁定、左滑露出的行、拖动中的块和子任务、退出整屏提示。挂上时 useLayer / pushLayer 入栈，收起、卸下出栈。
// • 层的根（spec.el）给层自己最外面那个元素；挂在 body 下的哪一块由这里往上找，各层不用自己找
// • Esc 只给栈顶：窗口捕获阶段最先收到。栈顶是模态层、或焦点在栈顶的根里：stopPropagation（Radix 自己的 Esc、元素上的 onKeyDown 都收不到，
//   不会一按关两层），调栈顶的 onEsc。栈顶是非模态层（左滑行、打字条、拖动、抽屉……）而焦点不在它里面：只 preventDefault（下面 Radix 层看到
//   defaultPrevented 不会自己关），先让焦点所在的元素处理（录快捷键的框接住 Esc 会 stopPropagation），没人接、冒泡回窗口再交给栈顶。
//   输入法组字时（composing）只拦不关
// • 模态层（modal）：栈顶往下最近的一个模态层，它和它上面的层挂在 body 下的那几块以外，body 下其余的直接子节点全部 inert，
//   <html> 加 scroll-locked（样式在 styles/base.css；sync-notice 也看它）。层挂在 body 下的 Portal 晚一步出现：模态层的根还没出现时先不动，
//   盯着 body 的子节点（增删）和它们的 inert 属性（我们设的被别人撤了再补上），变了重算。本来就 inert 的（别处设的）不碰；
//   里面没有能聚焦的元素的播报区（aria-live）不 inert（读屏照常播报；有按钮的照样 inert，Tab 走不到）
// • 还焦点：opener 是打开它的元素（useLayer 在 open 由 false 变 true 的那次渲染记；pushLayer 不给就取入栈那一刻的焦点）；
//   below 是入栈时下面那一层，打开它的元素不在了（下层先关、跟着卸掉了）就退到下面那层的 opener。怎么还见 useLayer.ts
// • 快捷键（useKeys）：同一个窗口监听（冒泡阶段，元素自己处理过的 defaultPrevented 不管）。从栈顶往下找接这个键的：
//   先是各层自己登记的键（useKeys 第二个参数给 useLayer 的返回值），碰到模态层就停——模态层开着时页面的键（Ctrl+K、Ctrl+N、日历左右键）一律收不到；
//   没有模态层时最后轮到页面的键，但焦点在哪个非模态层的根里时不带 mod 的页面键不生效（电脑日历详情抽屉里按 ← → 不翻月；
//   Ctrl+N、Ctrl+K 这类“任何地方都能按”的照常）。同一范围里后登记的先问。
//   键名见 keyName：mod = Ctrl 或 ⌘；不带 mod 的方向键、Enter 等和字母按着 Shift 时前面加 shift+（Shift+← 不当 ← 用）
// • 运行日志：入栈、出栈、Esc 关层各一行（layer push|pop|esc 名字 层数），不记内容
import { useEffect, useRef } from 'react';
import { opensKeyboard } from '../../platform/env.ts';
import { rlog } from '../../platform/run-log-api.ts';

export interface LayerSpec {
  /** 运行日志里的名字 */
  name: string;
  /** 层的根（最外面那个元素）：模态层用它算哪些 inert，Esc、页面键、还焦点用它认焦点在不在层里；Portal 晚出现时先返回 null，出现了会重算 */
  el?: (() => Element | null) | undefined;
  /** 模态：下面的内容 inert、锁滚动、页面快捷键收不到 */
  modal?: boolean | undefined;
  /** 模态但不锁滚动（隐私记锁屏：点“取消”直接换页，锁着滚动换页时文档从不能滚变成能滚，webkit 在 View Transition 里整页崩，base.css CI-webkit-crash） */
  keepScroll?: boolean | undefined;
  /** 栈顶时按 Esc 调；不给就只拦下 Esc（退出整屏提示） */
  onEsc?: (() => void) | undefined;
  /** 出栈时焦点按这个顺序还（参数是打开它的元素）；不给 = [打开它的元素]；返回 [] = 不还（Radix 自己还、或不该动焦点的层） */
  back?: ((opener: Element | null) => (Element | null | undefined)[]) | undefined;
}

export interface Layer {
  get: () => LayerSpec;
  /** 打开它的元素 */
  opener: Element | null;
  /** 入栈时下面那一层（还焦点的退路） */
  below: Layer | null;
}

export type KeyHandler = (e: KeyboardEvent) => boolean;
export type KeyMap = Partial<Record<string, KeyHandler>>;

/** 认层用（useKeys 第二个参数，useLayer 的返回值）：layer 是最近一次入栈的那一层（出栈了不在栈里，也就轮不到它的键） */
export interface LayerHandle {
  layer: Layer | null;
}

const stack: Layer[] = [];
/** 我们设的 inert */
const mine = new Set<Element>();
let watch: MutationObserver | null = null;
const regs: { map: { current: KeyMap }; owner: LayerHandle | null }[] = [];
let wired = false;

/** 输入法组字中：WebKit 组字时按的键 isComposing 可能是 false、keyCode 是 229 */
export const composing = (e: KeyboardEvent): boolean => e.isComposing || e.keyCode === 229;

/** 焦点（事件目标）在不在这一层的根里 */
const inside = (l: Layer, t: EventTarget | null): boolean => t instanceof Node && (l.get().el?.()?.contains(t) ?? false);

/** 挂在 body 下的那一块：从层的根往上找 body 的直接子节点 */
function topOf(n: Element | null): Element | null {
  while (n && n.parentElement !== document.body) n = n.parentElement;
  return n;
}

/** 里面没有能聚焦的元素的播报区：不 inert */
const quietLive = (n: Element): boolean =>
  (n.hasAttribute('aria-live') || n.querySelector('[aria-live]') !== null) &&
  n.querySelector('a[href],button,input,select,textarea,[tabindex],[contenteditable]') === null;

/** 栈顶往下最近的模态层的位置；没有是 -1 */
function modalAt(): number {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]?.get().modal) return i;
  return -1;
}

/** 按现在的栈重算 inert 和滚动锁 */
function sync(): void {
  const m = modalAt();
  const want = new Set<Element>();
  const keep = stack.slice(Math.max(m, 0)).map((l) => topOf(l.get().el?.() ?? null));
  if (m >= 0 && keep[0]) for (const c of document.body.children) if (!keep.includes(c) && !quietLive(c)) want.add(c);
  for (const n of mine) {
    if (want.has(n)) continue;
    n.removeAttribute('inert');
    mine.delete(n);
  }
  for (const n of want) {
    // 已经 inert 的：我们设的照旧，别处设的不碰；我们设的被撤了（没有属性了）补上
    if (n.hasAttribute('inert')) continue;
    n.setAttribute('inert', '');
    mine.add(n);
  }
  document.documentElement.classList.toggle('scroll-locked', m >= 0 && !stack[m]?.get().keepScroll);
  if (m < 0) {
    watch?.disconnect();
    watch = null;
    return;
  }
  watch ??= new MutationObserver(sync);
  watch.observe(document.body, { childList: true });
  for (const c of document.body.children) watch.observe(c, { attributeFilter: ['inert'] });
}

/** 按键名：'mod+n'、'?'、'j'、'ArrowLeft'、'shift+ArrowLeft'；mod = Ctrl 或 ⌘；带 Alt、Ctrl+⌘、Shift+mod 的返回 null */
export function keyName(e: KeyboardEvent): string | null {
  const mod = e.ctrlKey || e.metaKey;
  if (e.altKey || (e.ctrlKey && e.metaKey)) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod) return e.shiftKey ? null : `mod+${k}`;
  // Shift + 符号键本身就换了字（'/' → '?'），不再加前缀
  return e.shiftKey && (e.key.length > 1 || /^[a-z]$/i.test(e.key)) ? `shift+${k}` : k;
}

/** 交给栈顶关 */
function escTo(top: Layer, e: KeyboardEvent): void {
  e.preventDefault();
  const spec = top.get();
  rlog(`layer esc ${spec.name} n=${stack.length}`);
  spec.onEsc?.();
}

/** Esc：捕获阶段 */
function onEsc(e: KeyboardEvent): void {
  const top = stack.at(-1);
  if (e.key !== 'Escape' || !top) return;
  if (composing(e)) {
    e.stopPropagation();
    return;
  }
  if (!top.get().modal && !inside(top, e.target)) {
    e.preventDefault();
    return;
  }
  e.stopPropagation();
  escTo(top, e);
}

/** 冒泡阶段：没人接的 Esc 交给栈顶；快捷键范围从栈顶往下，碰到模态层停；都不是模态层时最后是页面（owner 为 null） */
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    const top = stack.at(-1);
    if (top && !composing(e)) escTo(top, e);
    return;
  }
  if (e.defaultPrevented || composing(e)) return;
  const name = keyName(e);
  if (name === null) return;
  const mod = name.startsWith('mod+');
  const typing = !mod && opensKeyboard(e.target);
  const m = modalAt();
  const scopes: (Layer | null)[] = stack.slice(Math.max(m, 0)).reverse();
  if (m < 0 && (mod || !stack.some((l) => inside(l, e.target)))) scopes.push(null);
  for (const scope of scopes) {
    for (let i = regs.length - 1; i >= 0; i--) {
      const r = regs[i];
      if (!r || (r.owner === null ? null : r.owner.layer) !== scope) continue;
      const fn = r.map.current[name];
      if (!fn || typing) continue;
      if (fn(e)) {
        e.preventDefault();
        return;
      }
    }
  }
}

function wire(): void {
  if (wired) return;
  wired = true;
  window.addEventListener('keydown', onEsc, true);
  window.addEventListener('keydown', onKey);
}

/** 入栈；返回这一层和出栈函数（出栈不动焦点，useLayer 在 passive 阶段还） */
export function pushLayer(get: () => LayerSpec, opener: Element | null = document.activeElement): { layer: Layer; pop: () => void } {
  wire();
  const layer: Layer = { get, opener, below: stack.at(-1) ?? null };
  stack.push(layer);
  rlog(`layer push ${get().name} n=${stack.length}`);
  sync();
  const pop = (): void => {
    const i = stack.indexOf(layer);
    if (i < 0) return;
    stack.splice(i, 1);
    rlog(`layer pop ${get().name} n=${stack.length}`);
    sync();
  };
  return { layer, pop };
}

/**
 * 窗口内快捷键（架构 5.9）：键名见 keyName；单字母键（没有 mod）焦点在能打字的地方（platform/env.ts 的 opensKeyboard）不生效；
 * 处理函数返回 true 才算接住（阻止默认动作），false 交给下一个、最后交给浏览器。owner 给了就只在那一层在栈里、轮到它时生效
 */
export function useKeys(map: KeyMap, owner: LayerHandle | null = null): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    wire();
    const r = { map: ref, owner };
    regs.push(r);
    return () => {
      const i = regs.indexOf(r);
      if (i >= 0) regs.splice(i, 1);
    };
  }, [owner]);
}

/** 撤掉这里设的一切（开发时热替换换掉这个模块前；测试用）：清栈（inert、滚动锁跟着撤）、摘监听 */
export function resetLayers(): void {
  stack.length = 0;
  regs.length = 0;
  sync();
  window.removeEventListener('keydown', onEsc, true);
  window.removeEventListener('keydown', onKey);
  wired = false;
}

if (import.meta.hot) import.meta.hot.dispose(resetLayers);
