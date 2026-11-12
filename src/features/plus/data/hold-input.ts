// 按住“＋”的手势（B3 任务单 FA-3、Q3；架构 5.1“按住 350ms”）：GlassBar 只把“＋”的 pointer 事件原样转过来（GlassBarProps.add.hold），
// 判定、系统长按的拦截都在这里，GlassBar 的 DOM、类名、样式一样不动
// • 按下：setPointerCapture（手指挪出“＋”也收得到 move、up）；“＋”上挂一次非被动 touchmove（按着、录着时 preventDefault：页面不滚、
//   不触发系统手势）和 contextmenu（一律 preventDefault，不出长按菜单）；<html data-plus-hold> 打标记，
//   plus 自己按需加载的 CSS（ui/RecordPanel.module.css，跟录音那一块走）据此关掉长按菜单、选字、放大镜，按着时整页 touch-action: none
// • 判定用 record-logic 的 holdStep（纯函数）：350 ms 到了没松开、没挪远 → start；之前松开 → 点一下（交给 GlassBar 原来的 onClick，这里不管）
// • 进了录音（接收方 start() 返回 true）以后，这一次松手浏览器补在“＋”上的那一下 click 吞掉（不然又打开打字条）；落在别处的 click 照常
// • 状态全是闭包里的普通变量，按住、移动期间 GlassBar 不重新渲染（Q3 守门第 6 条）
// 纯 TS：不准 import React（A1）
import { HOLD_IDLE, HOLD_MS, holdStep, type HoldEvent, type HoldState, type HoldZone } from './record-logic.ts';

/** React 的 PointerEvent 里用到的几样（GlassBar 转过来的就是它） */
export interface HoldPointer {
  button: number;
  isPrimary: boolean;
  pointerId: number;
  clientX: number;
  clientY: number;
  currentTarget: EventTarget | null;
}

/** 转给 GlassBar 的四个口子（和 GlassBarProps.add.hold 同一个形状） */
export interface HoldHandlers {
  onStart(e: HoldPointer): void;
  onMove(e: HoldPointer): void;
  onEnd(e: HoldPointer): void;
  onCancel(e: HoldPointer): void;
}

/** 判定结果交给谁（录音那边） */
export interface HoldSink {
  /** 按下了（还没判定）：el 是“＋”本身。手机自带识别要在手势里 start()，就在这一下里开 */
  down(el: HTMLElement): void;
  /** 按住 350 ms：返回 true 表示接手了（开录、出说明卡、出“没网”提示都算），之后松手补的 click 吞掉；false 当没按住 */
  start(): boolean;
  /** 手指现在在哪个区（录音面板量好的取消区、锁定区） */
  zoneAt(x: number, y: number): HoldZone;
  /** 手指进出取消区（界面高亮） */
  zone(z: HoldZone): void;
  lock(): void;
  /** 松手（不在取消区）：结束并上传 */
  finish(): void;
  /** 拖进取消区松手、系统收走了触摸（pointercancel）：丢掉 */
  discard(): void;
  /** 按下以后没进录音就结束了（点一下、挪远了）：手势里先开的手机识别要关掉 */
  idle(): void;
}

export interface HoldInput extends HoldHandlers {
  /** 录音那边自己结束了（锁定后点了“取消 / 记下”、60 秒到了、出错）：回到没按的状态 */
  reset(): void;
}

/** <html> 上的标记：data-plus-hold */
export const HOLD_ATTR = 'plusHold';
/** 进了录音以后松手，多久以内的那一下 click 吞掉 */
export const SWALLOW_MS = 800;

export function createHoldInput(sink: () => HoldSink | null, now: () => number = () => performance.now()): HoldInput {
  let s: HoldState = HOLD_IDLE;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** 这一次按下进了录音：松手时要吞掉随后的 click */
  let armed = false;
  let swallowUntil = 0;
  /** 按下的那个“＋”：只吞落在它上面的那一下 click（松手后马上点提示条上的按钮照常） */
  let pressed: Node | null = null;
  const hooked = new WeakSet<EventTarget>();
  let clickHooked = false;

  const live = (): boolean => s.phase === 'pressing' || s.phase === 'holding';
  const mark = (on: boolean): void => {
    const r = document.documentElement;
    if (on) r.dataset[HOLD_ATTR] = '';
    else delete r.dataset[HOLD_ATTR];
  };
  const toIdle = (): void => {
    clearTimeout(timer);
    s = HOLD_IDLE;
    mark(false);
  };

  const onTouchMove = (e: Event): void => {
    if (live()) e.preventDefault();
  };
  const onMenu = (e: Event): void => e.preventDefault();
  const onClick = (e: Event): void => {
    if (now() >= swallowUntil || !(e.target instanceof Node) || !pressed?.contains(e.target)) return;
    swallowUntil = 0;
    e.preventDefault();
    e.stopPropagation();
  };
  /** “＋”上的原生监听只挂一次（非被动 touchmove React 给不了；contextmenu 一并挂） */
  const hook = (el: EventTarget): void => {
    if (!hooked.has(el)) {
      hooked.add(el);
      el.addEventListener('touchmove', onTouchMove, { passive: false });
      el.addEventListener('contextmenu', onMenu);
    }
    if (!clickHooked) {
      clickHooked = true;
      // 捕获阶段挂在 window 上：比 React 挂在根节点上的 click 先到，吞掉就到不了 GlassBar 的 onClick
      window.addEventListener('click', onClick, true);
    }
  };

  const apply = (e: HoldEvent): void => {
    const was = s.phase;
    const prevZone = s.zone;
    const { state, action } = holdStep(s, e);
    s = state;
    const k = sink();
    switch (action) {
      case 'start':
        if (k?.start()) armed = true;
        else toIdle();
        break;
      case 'lock':
        k?.lock();
        break;
      case 'finish':
        k?.finish();
        break;
      case 'discard':
        k?.discard();
        break;
      case 'tap':
      case 'none':
        break;
      default: {
        const never: never = action;
        return never;
      }
    }
    if (s.phase === 'holding' && s.zone !== prevZone) k?.zone(s.zone);
    if (was === 'pressing' && s.phase === 'idle') k?.idle();
    if (s.phase === 'idle' || s.phase === 'locked') {
      clearTimeout(timer);
      mark(false);
    }
  };

  /** 350 ms 判定的计时器。计时器和 now() 不是同一个钟，可能早到一点（Node 按事件循环缓存的时间起算，负载下早到几十毫秒；
   *  FA-3 单测全量时运行日志只有“voice host ready”、没有“voice hold start”查明）：到了还没满就补上差的那一点再判，不丢这次按住 */
  const arm = (ms: number): void => {
    timer = setTimeout(() => {
      apply({ type: 'tick', t: now() });
      if (s.phase === 'pressing') arm(Math.max(1, HOLD_MS - (now() - s.downAt)));
    }, ms);
  };

  const zoneOf = (e: HoldPointer): HoldZone => (s.phase === 'holding' ? (sink()?.zoneAt(e.clientX, e.clientY) ?? null) : null);

  return {
    onStart(e) {
      // 右键、第二根手指不算；锁定着（面板盖着“＋”，一般按不到）不再开一次
      if (e.button !== 0 || !e.isPrimary || s.phase !== 'idle') return;
      const el = e.currentTarget;
      if (!(el instanceof HTMLElement)) return;
      hook(el);
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        // 指针已经没了（极少见）：照样判定
      }
      armed = false;
      pressed = el;
      apply({ type: 'down', t: now(), x: e.clientX, y: e.clientY });
      mark(true);
      sink()?.down(el);
      arm(HOLD_MS);
    },
    onMove(e) {
      if (!live()) return;
      apply({ type: 'move', t: now(), x: e.clientX, y: e.clientY, zone: zoneOf(e) });
    },
    onEnd(e) {
      if (armed) {
        armed = false;
        swallowUntil = now() + SWALLOW_MS;
      }
      if (s.phase === 'idle') return;
      apply({ type: 'up', t: now(), zone: zoneOf(e) });
    },
    onCancel() {
      armed = false;
      // 锁定以后手指的事都不管（松手也在录），系统收走触摸也不丢录音
      if (s.phase === 'idle' || s.phase === 'locked') return;
      apply({ type: 'cancel' });
    },
    reset() {
      toIdle();
    },
  };
}

// ---------- 模块级的那一份（转给 GlassBar 的就是它） ----------
let sinkNow: HoldSink | null = null;

/** 转给 GlassBar 的四个口子：ui/TypeBar.tsx 转出去，app/plus-slot.tsx 接到转发桥上。
 *  录音那一套（ui/RecordHost.tsx，按需加载）挂上以后用 setHoldSink 接手；没接手之前按住只当点一下 */
export const hold = createHoldInput(() => sinkNow);

export function setHoldSink(s: HoldSink | null): void {
  sinkNow = s;
}
