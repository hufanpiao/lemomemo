// 一个吉祥物的舞台：挂画布（有静态图的先挂静态图）、掉落回弹、看向、反应、暂停、卸载
// • 画布不接真实指针（CSS pointer-events: none）；#15、#18、#19 靠往画布派发模拟指针移动驱动素材自带的跟随
// • 静态图（MascotDef.still，构建时用 Rive 画的第一帧，build/gen_mascot_stills.mjs）：解码好就显示、开始降落；
//   Rive 画出第一帧有角色像素的画面那一刻，同一帧里显示画布、拿掉静态图。两者位置大小同一个算法（mascot-box.ts 的 stageBox），
//   画布像素自己定，不用 Rive 的 resizeDrawingSurfaceToCanvas（它量 getBoundingClientRect，降落途中量到的是缩放过的大小）
// • 页面不可见或不在屏幕内时暂停；减少动态效果时只淡入、画出首帧后停住（带表情的等表情到位、转场走完），不跳不摇，跟着设置切换
// • 载入失败只回调 onFail，不抛、不弹窗；静态图下载失败就等 Rive
// • 反应全由目录数据驱动、舞台不认 id：一般角色解释 react 的步骤（runStep）；带 forms 的短按换下一个形态；
//   带 moods 的事件和持续状态交给表情驱动（mascot-moods.ts，设素材里的直达输入）；载入时设 init 里的输入；lean 的整体往指针偏
import type * as RiveModule from '@rive-app/canvas';
import type { LookDef, MascotDef, ReactStep } from '../../shared/schema/mascot.ts';
import { hasInk, stageBox, type StageBox } from './mascot-box.ts';
import { createMoodRing, type MoodRing } from './mascot-moods.ts';

// 表情驱动只经舞台出口给外面（单测、目录一致性检查用）
export { createMoodRing, moodNameErrors, MOOD_EVENT_TTL_MS, MOOD_HOLD_MS, MOOD_RANDOM_MS, MOOD_RANDOM_REACH } from './mascot-moods.ts';
import { prefersReducedMotion, subscribeReducedMotion } from './reduced.ts';
import { bezierCss, ease as easeToken, mascotMotion } from './tokens.ts';

/** 下载由 platform/rive-load.ts 做（动效层不碰网络），调用方传进来 */
export interface StageLoaders {
  rive(): Promise<typeof RiveModule>;
  riv(url: string): Promise<ArrayBuffer>;
  /** 静态图：下载、解码好的图片元素；没给就不放静态图 */
  still?(url: string): Promise<HTMLImageElement>;
}

/** tap 是短按：有形态的（forms）换下一个形态，其余照 add 的反应 */
export type ReactKind = 'tap' | 'done' | 'add' | 'del';
export type MoodFlag = 'mail' | 'sleep';

/** 把连续的坐标合到每帧调一次（眼神跟手用）；cancel 丢掉还没调的那次 */
export function perFrame(fn: (x: number, y: number) => void): { call(x: number, y: number): void; cancel(): void } {
  let id = 0;
  let px = 0;
  let py = 0;
  return {
    call(x, y) {
      px = x;
      py = y;
      id ||= requestAnimationFrame(() => {
        id = 0;
        fn(px, py);
      });
    },
    cancel() {
      cancelAnimationFrame(id);
      id = 0;
    },
  };
}

interface InputLike {
  name: string;
  value: unknown;
  fire?(): void;
}
interface NodeLike {
  x: number;
  y: number;
}
interface VmLike {
  boolean(n: string): { value: boolean } | null;
  number(n: string): { value: number } | null;
  enum(n: string): { value: string } | null;
  trigger(n: string): { trigger(): void } | null;
}
interface RiveLike {
  devicePixelRatioUsed: number;
  resizeToCanvas(): void;
  drawFrame(): void;
  cleanup(): void;
  pause(): void;
  play(): void;
  stateMachineInputs(n: string): InputLike[] | undefined;
  viewModelInstance?: VmLike | null;
  artboard?: { node(n: string): NodeLike | null } | null;
}

export interface Stage {
  readonly ready: boolean;
  lookAt(x: number, y: number): void;
  react(kind: ReactKind): void;
  /** 有表情驱动（moods）的角色才有双击：双击随机换一个表情 */
  readonly canShuffle: boolean;
  shuffle(): void;
  /** 持续状态（提醒在响、久不操作）：只有带表情环（moods）的角色有反应，载入前设的载入后照样生效 */
  flag(f: MoodFlag, on: boolean): void;
  /** 这个屏幕点上有角色实际画出来的像素 */
  opaqueAt(x: number, y: number): boolean;
  setBool(name: string, v: boolean): void;
  destroy(): void;
}

type Vec = [number, number];

const DROP_MS = mascotMotion.drop * 1000;
let dropFrames: Keyframe[] | null = null;
/** 掉落回弹的关键帧：第一次用到才算 */
const dropKeyframes = (): Keyframe[] => (dropFrames ??= (() => {
  const seg: ReadonlyArray<readonly [number, number, 'fall' | 'hit' | 'air' | 'rest', number]> = [
    [0, 260, 'fall', 36],
    [260, 330, 'hit', 0.84],
    [330, 530, 'air', 16],
    [530, 580, 'hit', 0.92],
    [580, 710, 'air', 5],
    [710, 750, 'hit', 0.97],
    [750, 900, 'rest', 0],
  ];
  const out: Keyframe[] = [];
  for (let ms = 0; ms <= DROP_MS; ms += 10) {
    let y = 0;
    let sy = 1;
    for (const [a, b, kind, v] of seg) {
      if (ms < a || ms > b) continue;
      const u = (ms - a) / (b - a);
      if (kind === 'fall') y = -v * (1 - u * u);
      else if (kind === 'air') y = -v * 4 * u * (1 - u);
      else if (kind === 'hit') sy = 1 - (1 - v) * Math.sin(Math.PI * u);
      else sy = 1 + 0.015 * Math.sin(Math.PI * u) * (1 - u);
      break;
    }
    out.push({ offset: ms / DROP_MS, opacity: Math.min(1, ms / 100), transform: `translateY(${y.toFixed(2)}px) scale(${(1 / Math.sqrt(sy)).toFixed(3)},${sy.toFixed(3)})` });
  }
  return out;
})());

const STILL_MAX_FRAMES = 120;

/** 舞台建起来各段用时（运行日志 mascot init）：load 运行库和 .riv 都到手，init 从 new Rive 到 onLoad（wasm 编译、解析素材，主线程上的那一段） */
export interface StageTimes {
  load: number;
  init: number;
}

export interface StageCallbacks {
  onReady?(ms: StageTimes): void;
  onFail?(): void;
  /** 这一层第一次出现（静态图或 Rive 第一帧，先到的那个） */
  onShown?(): void;
  /** 静态图显示出来了、Rive 第一帧换上了（运行日志量各段用时） */
  onStill?(): void;
  onLive?(): void;
  /** 表情环走到了哪个表情、短按换到第几个形态（运行日志用，只有带 moods / forms 的角色有） */
  onMood?(name: string): void;
  onForm?(n: number): void;
  noDrop?: boolean;
}

export function createStage(el: HTMLElement, o: MascotDef, cb: StageCallbacks, load: StageLoaders): Stage {
  const [px, py] = o.pad ?? [0, 0];
  const layer = { position: 'absolute', display: 'block', pointerEvents: 'none', opacity: '0' };
  const c = document.createElement('canvas');
  Object.assign(c.style, layer);
  /** 静态图（解码好才交过来）：框有尺寸才显示；Rive 第一帧换上后拿掉（null） */
  let poster: HTMLImageElement | null = null;
  let box: StageBox | null = null;
  // 画布、静态图的大小位置按角色框（el）的尺寸算。框的尺寸来自吉祥物样式表：WebKit 里页面上另有样式表还在下载时，
  // 吉祥物样式表下完了也先不套用，这时框是 0（tests 里复现过）。所以不只建舞台时量一次：框的尺寸变了（含 0 → 有）就重算，框是 0 时不动
  const place = (): boolean => {
    const b = stageBox(o, el.clientWidth, el.clientHeight, window.devicePixelRatio);
    if (!b) return false;
    box = b;
    const at = { width: `${b.w}px`, height: `${b.h}px`, left: `${b.left}px`, top: `${b.top}px` };
    Object.assign(c.style, at);
    if (poster) Object.assign(poster.style, at);
    return true;
  };
  place();
  el.replaceChildren(c);

  const sm = o.sm ?? 'State Machine 1';
  const L: LookDef | undefined = o.look;
  let r: RiveLike | null = null;
  let ready = false;
  let dead = false;
  /** 画布像素按 stageBox 定（静态图也是按它出的），画一帧；尺寸没变不重设（重设会清空画布） */
  const fit = (): void => {
    if (!r || !box) return;
    if (c.width !== box.pw || c.height !== box.ph) {
      c.width = box.pw;
      c.height = box.ph;
    }
    r.devicePixelRatioUsed = box.dpr;
    r.resizeToCanvas();
    r.drawFrame();
  };
  const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
    if (!place()) return;
    if (ready) fit();
    showPoster();
  });
  ro?.observe(el);
  let raf = 0;
  let paused = false;
  let shown = true;
  /** 减少动态效果：画出过一帧（drawn）以后就停住 */
  let still = false;
  let drawn = false;
  let stillFrames = 0;
  let cur: Vec | null = null;
  let tgt: Vec | null = null;
  let last: Vec | null = null;
  let out = false;
  let leaving = false;
  let bob: (() => Vec) | null = null;
  let lean: Vec = [0, 0];
  const lc: Vec = [0, 0];
  let back: ReturnType<typeof setTimeout> | undefined;
  let eyeN: Array<[NodeLike, number, number]> | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => {
    const t = setTimeout(() => {
      timers.delete(t);
      if (!dead) fn();
    }, ms);
    timers.add(t);
    return t;
  };
  const cancelLater = (t: ReturnType<typeof setTimeout> | undefined): void => {
    if (t === undefined) return;
    clearTimeout(t);
    timers.delete(t);
  };
  /** 恢复定时器：同一个输入连续反应时只留最新的一个 */
  const restores = new Map<string, ReturnType<typeof setTimeout>>();
  const restoreLater = (key: string, fn: () => void, ms: number): void => {
    cancelLater(restores.get(key));
    restores.set(key, later(() => {
      restores.delete(key);
      fn();
    }, ms));
  };
  const inp =(n: string): InputLike | undefined => {
    try {
      return r?.stateMachineInputs(sm)?.find((i) => i.name === n);
    } catch {
      return undefined;
    }
  };
  const vm = (): VmLike | null => r?.viewModelInstance ?? null;
  const ring: MoodRing | null = o.moods
    ? createMoodRing(o.moods, {
        set: (n) => {
          const i = o.moods ? inp(o.moods.input) : undefined;
          if (i) i.value = n;
        },
        later,
        cancel: cancelLater,
        ...(cb.onMood ? { onMood: cb.onMood } : {}),
      })
    : null;
  /** 短按换下一个形态（forms） */
  const nextForm = (f: NonNullable<MascotDef['forms']>): void => {
    const v = vm()?.number(f.num);
    if (!v) return;
    v.value = (Math.round(v.value) + 1) % f.count;
    cb.onForm?.(v.value);
  };

  const fakeInit = (x: number, y: number): MouseEventInit => {
    const b = c.getBoundingClientRect();
    const k = b.width / o.size[0];
    return { clientX: b.left + (x + px) * k, clientY: b.top + (y + py) * k, bubbles: false, cancelable: true };
  };
  // Rive 在画布上只听 mouseover、mouseout、mousemove、mousedown、mouseup 和 touch*
  const ptrMove = (x: number, y: number): void => {
    const init = fakeInit(x, y);
    if (out) {
      out = false;
      c.dispatchEvent(new MouseEvent('mouseover', init));
    }
    c.dispatchEvent(new MouseEvent('mousemove', init));
  };
  const ptrLeave = (): void => {
    c.dispatchEvent(new MouseEvent('mouseout', { clientX: -9999, clientY: -9999, bubbles: false, cancelable: true }));
    out = true;
  };
  const toRest = (): void => {
    tgt = L ? [L.rest[0], L.rest[1]] : null;
    lean = [0, 0];
    if (L?.leave) leaving = true;
  };
  const lookAt = (x: number, y: number): void => {
    if (!ready) return;
    const b = c.getBoundingClientRect();
    const k = b.width / o.size[0];
    if (L?.eyes) {
      const e = el.getBoundingClientRect();
      const dx = x - (e.left + e.width / 2);
      const dy = y - (e.top + e.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      const m = L.max ?? [0, 0];
      tgt = [(dx / d) * m[0], (dy / d) * m[1]];
    } else if (L) {
      const [rx, ry] = L.restAB ?? L.rest;
      let dx = (x - b.left) / k - px - rx;
      let dy = (y - b.top) / k - py - ry;
      const dist = Math.hypot(dx, dy);
      const m = Math.min(dist, L.reach);
      if (dist > 0) {
        dx = (dx / dist) * m;
        dy = (dy / dist) * m;
      }
      let ax = rx + dx;
      let ay = ry + dy;
      if (L.box) {
        ax = Math.min(L.box[2], Math.max(L.box[0], ax));
        ay = Math.min(L.box[3], Math.max(L.box[1], ay));
      }
      tgt = L.toLocal(ax, ay);
    }
    if (o.lean) {
      const dx = x - (b.left + b.width / 2);
      const dy = y - (b.top + b.height / 2);
      const d = Math.hypot(dx, dy) || 1;
      lean = [(dx / d) * o.lean, (dy / d) * o.lean];
    }
    cancelLater(back);
    back = later(toRest, 2600);
  };
  const wiggle = (kind: 'nod' | 'shake'): void => {
    if (!L || prefersReducedMotion()) return;
    tgt ??= [L.rest[0], L.rest[1]];
    const t0 = performance.now();
    const amp = L.reach * (L.wig ?? 0.35);
    bob = () => {
      const t = (performance.now() - t0) / 1000;
      if (t > 0.9) {
        bob = null;
        return [0, 0];
      }
      const e = Math.sin(t * Math.PI * 4) * (1 - t / 0.9) * amp;
      return kind === 'nod' ? [0, e] : [e, 0];
    };
  };
  const hop = (): void => {
    if (prefersReducedMotion()) return;
    el.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-6px)' }, { transform: 'translateY(0)' }], { duration: mascotMotion.hop * 1000, easing: bezierCss(mascotMotion.hopEase) });
  };
  /** 反应的一步（目录 react 里写的，类型见 shared/schema/mascot.ts 的 ReactStep）；要还原的按输入、属性名只留最新的一次 */
  const runStep = (st: ReactStep): void => {
    switch (st.do) {
      case 'nod':
      case 'shake':
        wiggle(st.do);
        return;
      case 'hop':
        hop();
        return;
      case 'pulse': {
        const i = inp(st.input);
        if (!i) return;
        i.value = true;
        restoreLater(st.input, () => (i.value = false), st.ms);
        return;
      }
      case 'num': {
        const i = inp(st.input);
        if (!i) return;
        const v0 = o.init?.[st.input];
        const to = typeof v0 === 'number' ? v0 : 0;
        i.value = st.value;
        restoreLater(st.input, () => (i.value = to), st.ms);
        return;
      }
      case 'fire':
        inp(st.input)?.fire?.();
        return;
      case 'enum': {
        const e = vm()?.enum(st.prop);
        if (!e) return;
        e.value = st.value;
        const to = st.back;
        if (to !== undefined) restoreLater(st.prop, () => (e.value = to), st.ms ?? 0);
        return;
      }
      case 'trigger':
        vm()?.trigger(st.prop)?.trigger();
        return;
      case 'face':
        leaving = false;
        if (L) tgt = [L.rest[0], L.rest[1]];
        cancelLater(back);
        back = later(toRest, st.ms);
        return;
    }
  };
  const stepKey = (st: ReactStep): string => ('input' in st ? st.input : 'prop' in st ? st.prop : st.do);
  const play = (steps: readonly ReactStep[] | undefined): void => {
    for (const st of steps ?? []) {
      if (st.after) restoreLater(`after:${stepKey(st)}`, () => runStep(st), st.after);
      else runStep(st);
    }
  };

  const ease = (t: Vec): void => {
    if (!cur) return;
    cur[0] += (t[0] - cur[0]) * 0.18;
    cur[1] += (t[1] - cur[1]) * 0.18;
  };
  const nodeOf = (n: string): NodeLike | null => {
    try {
      return r?.artboard?.node(n) ?? null;
    } catch {
      return null;
    }
  };
  const step = (): void => {
    const off: Vec = bob ? bob() : [0, 0];
    if (L?.ptr && tgt) {
      cur ??= [L.rest[0], L.rest[1]];
      ease(tgt);
      const x = cur[0] + off[0];
      const y = cur[1] + off[1];
      if (!last || Math.abs(x - last[0]) + Math.abs(y - last[1]) > 0.5) {
        last = [x, y];
        ptrMove(x, y);
      }
      if (leaving && !bob && Math.abs(x - tgt[0]) + Math.abs(y - tgt[1]) < 2) {
        leaving = false;
        ptrLeave();
        tgt = null;
        cur = null;
        last = null;
      }
    } else if (L?.eyes && tgt) {
      if (!eyeN) {
        eyeN = [];
        for (let i = 1; i <= L.eyes; i++) {
          const n = nodeOf(`eye${i}`);
          if (n) eyeN.push([n, n.x, n.y]);
        }
      }
      cur ??= [0, 0];
      ease(tgt);
      for (const [n, x, y] of eyeN) {
        n.x = x + cur[0] + off[0];
        n.y = y + cur[1] + off[1];
      }
    } else if (L?.node && tgt) {
      const n = nodeOf(L.node);
      if (n) {
        cur ??= [n.x, n.y];
        ease(tgt);
        n.x = cur[0] + off[0];
        n.y = cur[1] + off[1];
      }
    }
    if (o.lean) {
      lc[0] += (lean[0] - lc[0]) * 0.15;
      lc[1] += (lean[1] - lc[1]) * 0.15;
      el.style.transform = `translate(${lc[0].toFixed(1)}px,${lc[1].toFixed(1)}px)`;
    }
  };
  const loop = (): void => {
    raf = 0;
    if (dead || paused || !ready) return;
    step();
    raf = requestAnimationFrame(loop);
  };
  const syncPause = (): void => {
    const p = document.visibilityState !== 'visible' || !shown || (still && drawn);
    if (p === paused) return;
    paused = p;
    // 看不到的时候不排空闲随机，恢复再排
    ring?.active(!p);
    if (!ready || !r) return;
    if (p) {
      r.pause();
      cancelAnimationFrame(raf);
      raf = 0;
    } else {
      r.play();
      raf = requestAnimationFrame(loop);
      ring?.kick();
    }
  };
  /** 画布上这一帧角色真画出来了（有的素材开头几帧是透明的，判断见 mascot-box.ts 的 hasInk） */
  const inked = (): boolean => {
    const g = c.getContext('2d');
    if (!g || c.width === 0 || c.height === 0) return false;
    return hasInk(g.getImageData(0, 0, c.width, c.height).data);
  };
  /** 带表情的角色还要等表情到了要的那个、转场走完（Aldo 开场是 Sleep，一画出来就停会停在下沉的半截） */
  let settledAt = 0;
  const moodSettled = (): boolean => {
    if (!ring || !o.moods) return true;
    if (ring.now !== ring.goal) {
      settledAt = 0;
      return false;
    }
    settledAt ||= performance.now();
    return performance.now() - settledAt >= o.moods.ms + 100;
  };
  /** 减少动态效果：画好了就停（一载入就停会是空画布），最多等 STILL_MAX_FRAMES 帧（带表情的两倍）；在帧回调外面停 */
  const stopWhenDrawn = (): void => {
    if (!still || drawn) return;
    stillFrames += 1;
    if (stillFrames < STILL_MAX_FRAMES * (ring ? 2 : 1) && !(inked() && moodSettled())) return;
    drawn = true;
    later(syncPause, 0);
  };
  const stopRm = subscribeReducedMotion(() => {
    if (!ready) return;
    still = prefersReducedMotion();
    syncPause();
  });
  // 没有这个接口的环境就当一直在屏幕内
  const io = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver((es) => {
    const e = es[es.length - 1];
    if (!e) return;
    shown = e.isIntersecting;
    syncPause();
  });
  io?.observe(el);
  document.addEventListener('visibilitychange', syncPause);

  /** 这一层第一次出现（静态图或 Rive 第一帧，先到的那个）：整层（el）降落，减少动态效果时整层淡入；静态图和画布在里面，换的时候跟着同一个动画 */
  let revealed = false;
  /** Rive 第一帧已经换上 */
  let live = false;
  const reveal = (): void => {
    if (revealed || dead) return;
    revealed = true;
    cb.onShown?.();
    if (prefersReducedMotion()) {
      el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: mascotMotion.fade * 1000, easing: bezierCss(easeToken.out) });
      return;
    }
    if (cb.noDrop) return;
    el.style.transformOrigin = '50% 100%';
    el.animate(dropKeyframes(), { duration: DROP_MS, easing: bezierCss(easeToken.linear) });
  };
  /** Rive 载入失败了：拿掉静态图，迟到的也不再放（失败时设置页预览、AI 栏会画别的退路，不能和静态图叠在一起） */
  let failed = false;
  /** 静态图已经显示 */
  let posterOn = false;
  /** 框有尺寸了才显示静态图（框是 0 时显示会按图片原尺寸撑开）；Rive 已经换上了就不再显示 */
  const showPoster = (): void => {
    if (!poster || !box || dead || failed || posterOn) return;
    posterOn = true;
    poster.style.opacity = '1';
    cb.onStill?.();
    reveal();
  };
  // 下载、解码失败就不放静态图，等 Rive
  if (o.still && load.still) {
    void load.still(o.still).then(
      (img) => {
        if (dead || live || failed) return;
        img.alt = '';
        img.draggable = false;
        Object.assign(img.style, layer);
        poster = img;
        place();
        el.insertBefore(img, c);
        showPoster();
      },
      () => undefined,
    );
  }
  /** Rive 这一帧画完（onAdvance 在 advance 之后、draw 之前回调，挪到微任务里就是画完、还没合成上屏）：
   *  第一次有角色像素时同一帧换上画布、拿掉静态图；过了 STILL_MAX_FRAMES 帧还看不出像素也照样换上
   *  （素材整个半透明过不了 hasInk 时，没有静态图的角色不至于永远不出来） */
  let liveFrames = 0;
  const afterDraw = (): void => {
    if (dead || !ready) return;
    if (!live) {
      liveFrames += 1;
      if (liveFrames < STILL_MAX_FRAMES && !inked()) return;
      live = true;
      c.style.opacity = '1';
      poster?.remove();
      poster = null;
      still = prefersReducedMotion();
      cb.onLive?.();
      reveal();
    }
    stopWhenDrawn();
  };
  const fail = (): void => {
    if (dead) return;
    failed = true;
    poster?.remove();
    poster = null;
    cb.onFail?.();
  };

  const tLoad = performance.now();
  void Promise.all([load.rive(), load.riv(o.url)])
    .then(([rive, buffer]) => {
      if (dead) return;
      const tInit = performance.now();
      const inst = new rive.Rive({
        buffer,
        canvas: c,
        ...(o.artboard ? { artboard: o.artboard } : {}),
        stateMachines: sm,
        autoplay: true,
        autoBind: o.novm !== true,
        isTouchScrollEnabled: true,
        enableRiveAssetCDN: false,
        onAdvance: () => queueMicrotask(afterDraw),
        ...(ring ? { onStateChange: (e: { data?: unknown }) => ring.report(Array.isArray(e.data) ? e.data.filter((x): x is string => typeof x === 'string') : []) } : {}),
        onLoad: () => {
          if (dead) return;
          r = inst as unknown as RiveLike;
          ready = true;
          // 输入先设好再画第一帧：静态图是按设好输入的第一帧出的（build/gen_mascot_stills.mjs 同一个顺序）
          for (const [name, v] of Object.entries(o.init ?? {})) {
            const i = inp(name);
            if (i) i.value = v;
          }
          ring?.kick();
          if (L && !L.leave) tgt = [L.rest[0], L.rest[1]];
          fit();
          cb.onReady?.({ load: Math.round(tInit - tLoad), init: Math.round(performance.now() - tInit) });
          if (paused) inst.pause();
          else raf = requestAnimationFrame(loop);
        },
        onLoadError: fail,
      });
      r = inst as unknown as RiveLike;
    })
    .catch(fail);

  return {
    get ready() {
      return ready;
    },
    lookAt,
    react(kind) {
      if (!ready) return;
      if (kind === 'tap' && o.forms) nextForm(o.forms);
      else if (ring && kind !== 'tap') ring.cue(kind);
      else play(o.react?.[kind === 'tap' ? 'add' : kind]);
    },
    canShuffle: ring !== null,
    shuffle() {
      if (ready) ring?.shuffle();
    },
    flag(f, on) {
      ring?.flag(f, on);
    },
    opaqueAt(x, y) {
      if (!ready) return false;
      const b = c.getBoundingClientRect();
      if (x < b.left || x >= b.right || y < b.top || y >= b.bottom) return false;
      const k = c.width / b.width;
      const g = c.getContext('2d');
      return g !== null && (g.getImageData(Math.floor((x - b.left) * k), Math.floor((y - b.top) * k), 1, 1).data[3] ?? 0) > 64;
    },
    setBool(name, v) {
      const p = vm()?.boolean(name);
      if (p) p.value = v;
    },
    destroy() {
      dead = true;
      cancelAnimationFrame(raf);
      for (const t of timers) clearTimeout(t);
      timers.clear();
      restores.clear();
      stopRm();
      io?.disconnect();
      ro?.disconnect();
      document.removeEventListener('visibilitychange', syncPause);
      try {
        r?.cleanup();
      } catch {
        // 卸载出错不影响页面
      }
      poster = null;
      el.replaceChildren();
    },
  };
}
