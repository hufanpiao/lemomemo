// 全局运行日志的版面快照和键盘检查（从 run-log.ts 按职责拆出：这里只读屏幕上的位置和根节点标记，不挂事件、不存日志；只进非正式版）
// • root：根节点的 data-kbo、--kb、--vh-gap（名字引 viewport-geom.ts 的常量，和 viewport.ts 写的同一份）
// • vvState：innerHeight、可视区高度和偏移、缩放（偏离 1 超过 viewport-geom.ts 的 SCALE_EPS 才记）、scrollY、root、焦点元素
// • layout：LAYOUT_TARGETS 各元素，以及焦点输入框和它所在浮层：相对可视区的上沿~下沿、高度、是否藏着
// • kbcheck（台账 Q-8）：焦点进来时 markFocus 记下滚动位置和可视区偏移，停稳后一行结论：系统滚没滚页面、浮条贴没贴键盘
// 隐私：元素只记标签、type、data-testid / aria-label / id，不记内容文字
import { opensKeyboard } from './env.ts';
import { BAR_SELECTOR } from './run-log-api.ts';
import { GAP_VAR, KB_VAR, KBO_ATTR, SCALE_EPS } from './viewport-geom.ts';

/** 版面快照要看的元素 */
export const LAYOUT_TARGETS: ReadonlyArray<readonly [string, string]> = [
  ['bar', BAR_SELECTOR],
  ['add', '[data-testid="tabbar-add"]'],
  ['band', '[data-testid="tabbar-band"]'],
  ['type', '[data-testid="type-bar"]'],
  ['inrow', '[data-testid="notes-input-row"]'],
  ['undo', '[data-testid="undo-toast"]'],
];

/** 元素的简短说明：标签名 + type + data-testid / aria-label / id（不含内容文字） */
export function describeEl(el: unknown): string {
  if (!(el instanceof Element)) return '-';
  const tag = el.tagName.toLowerCase();
  const type = el instanceof HTMLInputElement ? `[${el.type}]` : '';
  const id = el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.getAttribute('id') ?? '';
  return `${tag}${type}${id ? `#${id.slice(0, 40)}` : ''}`;
}

export interface LayoutProbe {
  /** 根节点上的键盘标记：`kbo= kb= gap=` */
  root(): string;
  /** 视口状态一段 */
  vvState(): string;
  /** 版面快照一段：`[bar=… add=… … field=… host=…]` */
  layout(): string;
  /** 焦点进来时调：记下这时的滚动位置和可视区偏移 */
  markFocus(): void;
  /** 焦点停稳后一行结论；焦点不在会弹键盘的框里、或没有 visualViewport 时 null */
  kbcheck(): string | null;
}

export function createLayoutProbe(win: Window): LayoutProbe {
  const doc = win.document;
  const root = doc.documentElement;
  const vv = win.visualViewport;
  const cssVar = (k: string): string => root.style.getPropertyValue(k).trim() || '0';
  const rootState = (): string => `kbo=${root.hasAttribute(KBO_ATTR) ? 1 : 0} kb=${cssVar(KB_VAR)} gap=${cssVar(GAP_VAR)}`;
  /** 一个元素在屏幕上的位置和可见性：相对可视区的上沿~下沿、高度；藏着记 hid，不在页面里记 none */
  const rectOf = (el: Element | null): string => {
    if (!el) return 'none';
    const r = el.getBoundingClientRect();
    let vis = '';
    try {
      const cs = win.getComputedStyle(el);
      if (cs.visibility === 'hidden') vis = ' hid';
      else if (cs.display === 'none') vis = ' nodisp';
      else if (Number(cs.opacity) === 0) vis = ' op0';
    } catch {
      vis = '';
    }
    const off = vv ? vv.offsetTop : 0;
    return `${Math.round(r.top - off)}~${Math.round(r.bottom - off)}h${Math.round(r.height)}${vis}`;
  };
  /** 焦点所在的浮层（最近的 position: fixed 祖先） */
  const fixedHost = (el: Element | null): Element | null => {
    for (let n = el; n && n !== doc.body; n = n.parentElement) {
      try {
        if (win.getComputedStyle(n).position === 'fixed') return n;
      } catch {
        return null;
      }
    }
    return null;
  };
  /** 焦点进来时的滚动位置和可视区偏移：kbcheck 用它们算系统滚了多少文档（dy）、平移了多少可视区（dtop） */
  let focusY = 0;
  let focusTop = 0;

  return {
    root: rootState,
    vvState: () =>
      `inner=${win.innerHeight} vv=${vv ? Math.round(vv.height) : '-'} top=${vv ? Math.round(vv.offsetTop) : '-'}${vv && Math.abs(vv.scale - 1) > SCALE_EPS ? ` scale=${vv.scale.toFixed(2)}` : ''} y=${Math.round(win.scrollY)} ${rootState()} focus=${describeEl(doc.activeElement)}`,
    layout: () => {
      const parts = LAYOUT_TARGETS.map(([k, sel]) => `${k}=${rectOf(doc.querySelector(sel))}`);
      const act = doc.activeElement;
      if (opensKeyboard(act)) {
        parts.push(`field=${rectOf(act)}`);
        const host = fixedHost(act);
        parts.push(`host=${host ? `${describeEl(host)}:${rectOf(host)}` : 'none'}`);
      }
      return `[${parts.join(' ')}]`;
    },
    markFocus: () => {
      focusY = win.scrollY;
      focusTop = vv?.offsetTop ?? 0;
    },
    /**
     * dy 文档滚了多少、dtop 可视区平移了多少（都是 0 = 系统没动）、top 可视区偏移、
     * dock 浮层下沿离可视区底多远（0～12 = 贴着键盘）、fieldIn 输入框整个在可视区里
     */
    kbcheck: () => {
      const act = doc.activeElement;
      if (!opensKeyboard(act) || !vv) return null;
      const top = vv.offsetTop;
      const f = act.getBoundingClientRect();
      const host = fixedHost(act)?.getBoundingClientRect();
      const dock = host ? Math.round(vv.height - (host.bottom - top)) : '-';
      const tail = `top=${Math.round(top)} dock=${dock} fieldIn=${f.top >= top && f.bottom - top <= vv.height ? 1 : 0}`;
      return `kbcheck dy=${Math.round(win.scrollY - focusY)} dtop=${Math.round(top - focusTop)} ${tail}`;
    },
  };
}
