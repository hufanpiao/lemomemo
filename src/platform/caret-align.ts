// 光标对齐（台账 Q-8 试验，11-11；真机过了再转正）：iOS 主屏幕版键盘弹出后，页面滚动位置（scrollY）比可视区偏移（visualViewport.offsetTop）多 62（顶部安全区），
// 打字条按一套坐标画、光标按另一套画，光标比输入框低 62pt。负责人 preview.267 试验（caret-sync 诊断开关）真机：对齐后差值 62→1，“光标先在下面后来又回到框里”。
// 做法：输入框聚焦、键盘停稳（visualViewport 停止变化 SETTLE_MS）后，两者差超过 TOL_PX 就 scrollTo(0, offsetTop)，再在原位置重设一次选区让 iOS 重画光标。
// 补抬（preview.267 试验视频：对齐后 iOS 把布局视口拉成 inner=605、可视区仍 543，贴底的浮条掉进键盘下 62pt，“展开编辑、收起”被盖住）：
// 对齐过以后，只要还聚焦在输入框，就把 inner − vv.height 写进根节点 --caret-lift，base.css 键盘弹着时 --dock-bottom 加上它；
// resize 一来立刻重算（不等停稳），失焦或差值归零就清掉。一次聚焦只对齐一次，之后 iOS 再滚也不跟着滚（防来回打架），失焦后下次聚焦重新算。
// 补抬不减 vv.offsetTop（独立验证 11-11 建议 5 不采纳）：真机日志对齐后 top=289、inner=605、vv=543，减了就成 0，可视频里打字条确实掉了 62，按 inner − vv 才对得上。
// 现在只在非正式版诊断开关“Caret sync”开着时由 caret-sync.ts 启动；onLine 给诊断页记日志
export const SETTLE_MS = 120;
export const TOL_PX = 2;
export const LIFT_VAR = '--caret-lift';

type Field = HTMLInputElement | HTMLTextAreaElement;

function isField(el: Element | null): el is Field {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
}

/** 开始盯；返回停止函数 */
export function startCaretAlign(win: Window = window, onLine?: (line: string) => void, settleMs: number = SETTLE_MS): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => undefined;
  const state = (): string =>
    `inner=${win.innerHeight} vv=${Math.round(vv.height)} top=${Math.round(vv.offsetTop)} y=${Math.round(win.scrollY)}`;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 这次聚焦里对齐过没有（对齐过才补抬） */
  let synced = false;
  let lift = 0;
  const root = win.document.documentElement;
  const setLift = (): void => {
    const want = synced && isField(win.document.activeElement) ? Math.max(0, Math.round(win.innerHeight - vv.height)) : 0;
    if (want === lift) return;
    lift = want;
    if (want > 0) root.style.setProperty(LIFT_VAR, `${want}px`);
    else root.style.removeProperty(LIFT_VAR);
    onLine?.(`lift=${want} ${state()}`);
  };
  const settle = (): void => {
    const el = win.document.activeElement;
    if (!isField(el)) return;
    // 一次聚焦只对齐一次（preview.267 日历页视频：对齐后 iOS 又把输入框往可视区里滚，两边来回打架 1.5 秒、打字条在键盘上下跳 3～4 次）
    if (synced) return;
    const top0 = Math.round(el.getBoundingClientRect().top);
    const diff = Math.round(win.scrollY - vv.offsetTop);
    if (Math.abs(diff) <= TOL_PX) {
      onLine?.(`skip diff=${diff} ${state()} el=${top0}`);
      return;
    }
    const before = state();
    win.scrollTo(0, vv.offsetTop);
    synced = true;
    const pos = el.selectionStart ?? el.value.length;
    try {
      el.setSelectionRange(pos, pos);
    } catch {
      // 某些 type 不支持选区：只做滚动对齐
    }
    onLine?.(`sync diff=${diff} before ${before} el=${top0} after ${state()} el=${Math.round(el.getBoundingClientRect().top)}`);
    setLift();
  };
  const onChange = (): void => {
    setLift();
    clearTimeout(timer);
    timer = setTimeout(settle, settleMs);
  };
  vv.addEventListener('resize', onChange);
  vv.addEventListener('scroll', onChange);
  win.document.addEventListener('focusin', onChange);
  /** 失焦：这次对齐结束，补抬清掉 */
  const onOut = (): void => {
    synced = false;
    setLift();
  };
  win.document.addEventListener('focusout', onOut);
  win.addEventListener('resize', setLift);
  return () => {
    win.document.removeEventListener('focusout', onOut);
    win.removeEventListener('resize', setLift);
    root.style.removeProperty(LIFT_VAR);
    clearTimeout(timer);
    vv.removeEventListener('resize', onChange);
    vv.removeEventListener('scroll', onChange);
    win.document.removeEventListener('focusin', onChange);
  };
}
