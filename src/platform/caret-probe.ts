// 打字条光标跑到框外（画在输入框左上方）的定位日志。
// JS 读不到系统光标的位置，只能记它依赖的东西：输入框的位置、可视区偏移、整页滚动、框内横向滚动、选区下标、
// 祖先里会让 iOS 把光标画偏的层（transform、filter、backdrop-filter、will-change、contain）、页面上还在播的动画数。
// 聚焦后记 4 次，看光标出错时这些值是不是还在变。不记输入的文字，只记下标和长度。
// 只由懒加载的打字条引用，不进首屏
import { RLOG_ON, rlog } from './run-log-api.ts';

const STEPS_MS = [0, 120, 400, 1000] as const;
const MAX_LAYERS = 6;
const on = (v: string | undefined): boolean => Boolean(v) && v !== 'none' && v !== 'auto' && v !== 'normal';

/** 从输入框往上，带合成层属性的祖先：标签名:属性首字母（t 变换、f 滤镜、b 背景模糊、w will-change、c contain） */
function layers(el: Element): string {
  const out: string[] = [];
  for (let p = el.parentElement; p && out.length < MAX_LAYERS; p = p.parentElement) {
    const cs = getComputedStyle(p);
    const marks = [
      on(cs.transform) ? 't' : '',
      on(cs.filter) ? 'f' : '',
      on(cs.backdropFilter) ? 'b' : '',
      on(cs.willChange) ? 'w' : '',
      on(cs.contain) ? 'c' : '',
    ].join('');
    if (marks) out.push(`${p.tagName.toLowerCase()}:${marks}`);
  }
  return out.join(',') || '-';
}

/** 一行定位日志（不含任何输入内容） */
export function caretLine(el: HTMLInputElement, ms: number): string {
  const r = el.getBoundingClientRect();
  const vv = window.visualViewport;
  const anims = typeof document.getAnimations === 'function' ? document.getAnimations().length : -1;
  return `caretprobe +${ms} field=${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`
    + ` vv=${Math.round(vv?.offsetLeft ?? 0)},${Math.round(vv?.offsetTop ?? 0)},${Math.round(vv?.height ?? 0)}`
    + ` page=${Math.round(window.scrollX)},${Math.round(window.scrollY)} in=${Math.round(el.scrollLeft)}`
    + ` sel=${el.selectionStart ?? -1}/${el.value.length} act=${document.activeElement === el ? 1 : 0} anim=${anims} layers=${layers(el)}`;
}

/** 聚焦时调一次：分几个时刻记，输入框卸掉了就不记 */
export function probeCaret(el: HTMLInputElement): void {
  // 正式版不记运行日志：不排这 4 个定时器
  if (!RLOG_ON) return;
  for (const ms of STEPS_MS) {
    setTimeout(() => {
      if (el.isConnected) rlog(caretLine(el, ms));
    }, ms);
  }
}
