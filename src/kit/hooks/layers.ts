// 层栈和窗口内快捷键（第三方审查前端-8、14：弹层的 Esc、还焦点原来 5 种写法，直接挂 keydown 9 处，收成这一套）
// 分两个文件：这里是首屏要带的核心（栈、Esc、inert、快捷键；App 的 Ctrl+N 和退出整屏提示用）；React 的 useLayer 和还焦点在 useLayer.ts（只有懒加载的层用，不进首屏）
// 层：盖在页面上、按 Esc 该收起的东西都算——kit Dialog、查找面板和结果层、纪念日编辑层、附件整窗浮层、详情抽屉、kit Popover、
//   打字条、录音锁定、左滑露出的行、拖动中的块和子任务、退出整屏提示。挂上时 useLayer / pushLayer 入栈，收起、卸下出栈。
// • Esc 只给栈顶：窗口捕获阶段最先收到，栈里有层就 stopPropagation（Radix 自己的 Esc、元素上的 onKeyDown 都收不到，不会一按关两层），
//   调栈顶的 onEsc；输入法组字时只拦不关
// • 模态层（modal）：栈顶往下最近的一个模态层，它和它上面的层以外的内容全部 inert（沿层的根往上，每一级的兄弟节点），
//   <html> 加 scroll-locked（样式在 styles/base.css；sync-notice 也看它）。层挂在 body 下的 Portal 晚一步出现，
//   所以有模态层时盯着 body 的子节点，变了重算。本来就 inert 的（别处设的）不碰；带 aria-live 的不 inert（读屏照常播报）
// • 还焦点：入栈那一刻记下 document.activeElement（opener）；怎么还见 useLayer.ts
// • 快捷键（useKeys）：同一个窗口监听（冒泡阶段，元素自己处理过的 defaultPrevented 不管）。从栈顶往下找接这个键的：
//   先是各层自己登记的键（useKeys 第二个参数给 useLayer 的返回值），碰到模态层就停——模态层开着时页面的键（Ctrl+K、Ctrl+N、日历左右键）一律收不到；
//   没有模态层时最后轮到页面的键。同一范围里后登记的先问（日历页挂着时先记下选中的那天，App 的 Ctrl+N 再打开打字条）
// • 运行日志：入栈、出栈、Esc 关层各一行（layer push|pop|esc 名字 层数），不记内容
import { useEffect, useRef } from 'react';
import { opensKeyboard } from '../../platform/env.ts';
import { rlog } from '../../platform/run-log-api.ts';

export interface LayerSpec {
  /** 运行日志里的名字 */
  name: string;
  /** 层的根（模态层用它算哪些 inert、焦点在不在层里）；Portal 晚出现时先返回 null，出现了会重算 */
  el?: (() => Element | null) | undefined;
  /** 模态：下面的内容 inert、锁滚动、页面快捷键收不到 */
  modal?: boolean | undefined;
  /** 栈顶时按 Esc 调；不给就只拦下 Esc（退出整屏提示） */
  onEsc?: (() => void) | undefined;
  /** 出栈时焦点按这个顺序还（参数是入栈那一刻的焦点）；不给 = [打开它的元素]；返回 [] = 不还（Radix 自己还、或不该动焦点的层） */
  back?: ((opener: Element | null) => (Element | null | undefined)[]) | undefined;
}

export interface Layer {
  get: () => LayerSpec;
  opener: Element | null;
}

export type KeyHandler = (e: KeyboardEvent) => boolean;
export type KeyMap = Partial<Record<string, KeyHandler>>;

/** 认层用（useKeys 第二个参数，useLayer 的返回值）：layer 是在栈里时的那一层，不在栈里是 null */
export interface LayerHandle {
  layer: Layer | null;
}

const stack: Layer[] = [];
/** 我们设的 inert */
const mine = new Set<Element>();
let watch: MutationObserver | null = null;
const regs: { map: { current: KeyMap }; owner: LayerHandle | null }[] = [];
let wired = false;

/** 栈顶往下最近的模态层的位置；没有是 -1 */
function modalAt(): number {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i]?.get().modal) return i;
  return -1;
}

/** 按现在的栈重算 inert 和滚动锁 */
function sync(): void {
  const m = modalAt();
  const want = new Set<Element>();
  if (m >= 0) {
    const path = new Set<Element>();
    for (const l of stack.slice(m)) {
      for (let n = l.get().el?.() ?? null; n && n !== document.body; n = n.parentElement) path.add(n);
    }
    for (const n of path) for (const s of n.parentElement?.children ?? []) if (!path.has(s) && !s.hasAttribute('aria-live')) want.add(s);
  }
  for (const n of mine) {
    if (want.has(n)) continue;
    n.removeAttribute('inert');
    mine.delete(n);
  }
  for (const n of want) {
    if (mine.has(n) || n.hasAttribute('inert')) continue;
    n.setAttribute('inert', '');
    mine.add(n);
  }
  document.documentElement.classList.toggle('scroll-locked', m >= 0);
  if (m >= 0 && !watch) {
    watch = new MutationObserver(sync);
    watch.observe(document.body, { childList: true });
  } else if (m < 0 && watch) {
    watch.disconnect();
    watch = null;
  }
}

/** 按键名：'mod+n'、'?'、'j'、'ArrowLeft'；mod = Ctrl 或 ⌘；带 Alt、Ctrl+⌘、Shift+mod 的返回 null */
export function keyName(e: KeyboardEvent): string | null {
  const mod = e.ctrlKey || e.metaKey;
  if (e.altKey || (e.ctrlKey && e.metaKey)) return null;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod) return e.shiftKey ? null : `mod+${k}`;
  return k;
}

/** Esc：捕获阶段，栈里有层就整个拦下，交给栈顶 */
function onEsc(e: KeyboardEvent): void {
  const top = stack.at(-1);
  if (e.key !== 'Escape' || !top) return;
  e.stopPropagation();
  if (e.isComposing || e.keyCode === 229) return;
  e.preventDefault();
  const spec = top.get();
  rlog(`layer esc ${spec.name} n=${stack.length}`);
  spec.onEsc?.();
}

/** 快捷键：冒泡阶段。范围从栈顶往下，碰到模态层停；都不是模态层时最后是页面（owner 为 null） */
function onKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing) return;
  const name = keyName(e);
  if (name === null) return;
  const typing = !name.startsWith('mod+') && opensKeyboard(e.target);
  const m = modalAt();
  const scopes: (Layer | null)[] = stack.slice(Math.max(m, 0)).reverse();
  if (m < 0) scopes.push(null);
  for (const scope of scopes) {
    for (let i = regs.length - 1; i >= 0; i--) {
      const r = regs[i];
      if (!r || (r.owner === null ? null : r.owner.layer ?? undefined) !== scope) continue;
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

/** 入栈；返回出栈函数（出栈不动焦点，useLayer 在 passive 阶段还） */
export function pushLayer(get: () => LayerSpec): () => void {
  wire();
  const layer: Layer = { get, opener: document.activeElement };
  stack.push(layer);
  rlog(`layer push ${get().name} n=${stack.length}`);
  sync();
  return () => {
    const i = stack.indexOf(layer);
    if (i < 0) return;
    stack.splice(i, 1);
    rlog(`layer pop ${get().name} n=${stack.length}`);
    sync();
  };
}

/** 栈顶那一层（useLayer 入栈后认自己） */
export const topLayer = (): Layer | null => stack.at(-1) ?? null;

/**
 * 窗口内快捷键（架构 5.9）：键名见 keyName；单字母键（没有 mod）焦点在能打字的地方（platform/env.ts 的 opensKeyboard）不生效；
 * 处理函数返回 true 才算接住（阻止默认动作），false 交给下一个、最后交给浏览器。owner 给了就只在那一层在栈里、轮到它时生效
 */
export function useKeys(map: KeyMap, owner: LayerHandle | null = null): void {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => register(ref, owner), [owner]);
}

/** 不在组件里的登记（日历页 watchAddClick），只登记页面的键；返回取消函数 */
export const addKeys = (map: KeyMap): (() => void) => register({ current: map }, null);

function register(map: { current: KeyMap }, owner: LayerHandle | null): () => void {
  wire();
  const r = { map, owner };
  regs.push(r);
  return () => {
    const i = regs.indexOf(r);
    if (i >= 0) regs.splice(i, 1);
  };
}
