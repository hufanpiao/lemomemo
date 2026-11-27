// 吉祥物舞台（motion/mascot-stage.ts）：用假的 Rive 运行库验
// • 反应数据（目录 react）怎么解释：每一步做什么、什么时候还原、连着来只留最新的还原
// • 载入时设 init 里的输入
// • 离屏暂停时不排空闲随机，回到屏幕内补排、并把要的表情再设一次（kick）
// • 角色框建舞台时还是 0（WebKit 里样式表还没套上）：框有了尺寸再摆画布、重设绘图面
// • 减少动态效果：画出来就停；带表情的等表情到位、转场走完再停，等不到最多等 STILL_MAX_FRAMES 的两倍帧
// • 静态图：解码好、框有尺寸才显示并开始降落；Rive 第一帧有角色像素时同一帧换上画布、拿掉静态图；下载失败等 Rive；输入先设好再画第一帧
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MascotDef } from '../../../shared/schema/mascot.ts';
import { createStage, MOOD_RANDOM_MS, type Stage } from '../mascot-stage.ts';

const h = vi.hoisted(() => ({ reduced: false, rmSub: null as null | (() => void) }));
vi.mock('../reduced.ts', () => ({
  prefersReducedMotion: () => h.reduced,
  subscribeReducedMotion: (fn: () => void) => {
    h.rmSub = fn;
    return () => undefined;
  },
}));

interface FakeInput {
  name: string;
  value: unknown;
  sets: unknown[];
  fire: ReturnType<typeof vi.fn>;
}
interface RiveOpts {
  onLoad(): void;
  onAdvance(): void;
  onStateChange?(e: { data?: unknown }): void;
}

/** 假的运行库：记下建 Rive 时的参数、各输入设过的值、枚举和触发器 */
function fakeRuntime(names: readonly string[]) {
  const inputs: FakeInput[] = names.map((name) => {
    const sets: unknown[] = [];
    let v: unknown = 0;
    return {
      name,
      sets,
      fire: vi.fn(),
      get value() {
        return v;
      },
      set value(x: unknown) {
        v = x;
        sets.push(x);
      },
    };
  });
  const enums: Record<string, { value: string }> = {};
  const triggers: Record<string, { trigger: ReturnType<typeof vi.fn> }> = {};
  const rt = {
    opts: null as RiveOpts | null,
    pause: vi.fn(),
    play: vi.fn(),
    /** drawFrame 每次调用时的像素比 */
    resized: [] as number[],
    /** 第一次 drawFrame 时各输入的值（输入要先设好再画第一帧） */
    firstDraw: null as Record<string, unknown> | null,
    inputs,
    input: (n: string): FakeInput => inputs.find((i) => i.name === n) as FakeInput,
    enums,
    triggers,
  };
  class Rive {
    viewModelInstance = {
      boolean: () => null,
      number: () => null,
      enum: (n: string) => (enums[n] ??= { value: '' }),
      trigger: (n: string) => (triggers[n] ??= { trigger: vi.fn() }),
    };
    artboard = null;
    constructor(o: RiveOpts) {
      rt.opts = o;
    }
    devicePixelRatioUsed = 0;
    resizeToCanvas(): void {}
    drawFrame(): void {
      rt.resized.push(this.devicePixelRatioUsed);
      rt.firstDraw ??= Object.fromEntries(inputs.map((i) => [i.name, i.value]));
    }
    cleanup(): void {}
    pause(): void {
      rt.pause();
    }
    play(): void {
      rt.play();
    }
    stateMachineInputs(): FakeInput[] {
      return inputs;
    }
  }
  const load = { rive: () => Promise.resolve({ Rive } as never), riv: () => Promise.resolve(new ArrayBuffer(8)) };
  return { rt, load };
}

let io: ((es: { isIntersecting: boolean }[]) => void) | null = null;
const ink = { on: true };
let stage: Stage | null = null;
const box = (): HTMLElement => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
};
const base: MascotDef = { url: 'x.riv', size: [100, 100], crop: [0, 0, 100, 100] };
/** 等假运行库的 Promise 走完，再调 onLoad */
async function loaded(rt: ReturnType<typeof fakeRuntime>['rt']): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
  rt.opts?.onLoad();
  await vi.advanceTimersByTimeAsync(40);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'] });
  h.reduced = false;
  io = null;
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.stubGlobal('IntersectionObserver', class {
    constructor(cb: (es: { isIntersecting: boolean }[]) => void) {
      io = cb;
    }
    observe(): void {}
    disconnect(): void {}
  });
  // 画布每个像素都不透明：hasInk 一画就算画出来了（ink.on 设成 false 是开头几帧透明的素材）
  ink.on = true;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    return { getImageData: (_x: number, _y: number, w: number, hh: number) => ({ data: new Uint8ClampedArray(w * hh * 4).fill(ink.on ? 255 : 0) }) } as never;
  });
  Element.prototype.animate = vi.fn() as never;
});
afterEach(() => {
  stage?.destroy();
  stage = null;
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('反应数据怎么解释', () => {
  const def: MascotDef = {
    ...base,
    init: { Eye: 4 },
    react: {
      done: [
        { do: 'num', input: 'Eye', value: 3, ms: 1200 },
        { do: 'fire', input: 'Walk' },
        { do: 'fire', input: 'Stop', after: 1200 },
        { do: 'enum', prop: 'state', value: 'speaking', back: 'idle', ms: 1200 },
        { do: 'enum', prop: 'poses', value: 'giggle' },
        { do: 'trigger', prop: 'tap' },
        { do: 'pulse', input: 'Big', ms: 700 },
      ],
      add: [{ do: 'pulse', input: 'Big', ms: 900 }],
    },
  };

  it('载入时设 init；勾完逐步执行，到点还原（数字回 init、枚举回 back、after 的晚点再做、没写 back 的不还原）', async () => {
    const { rt, load } = fakeRuntime(['Eye', 'Walk', 'Stop', 'Big']);
    stage = createStage(box(), def, {}, load);
    await loaded(rt);
    expect(rt.input('Eye').value).toBe(4);
    stage.react('done');
    expect(rt.input('Eye').value).toBe(3);
    expect(rt.input('Walk').fire).toHaveBeenCalledTimes(1);
    expect(rt.input('Stop').fire).not.toHaveBeenCalled();
    expect(rt.enums['state']?.value).toBe('speaking');
    expect(rt.enums['poses']?.value).toBe('giggle');
    expect(rt.triggers['tap']?.trigger).toHaveBeenCalledTimes(1);
    expect(rt.input('Big').value).toBe(true);
    await vi.advanceTimersByTimeAsync(700);
    expect(rt.input('Big').value).toBe(false);
    expect(rt.input('Eye').value).toBe(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(rt.input('Eye').value).toBe(4);
    expect(rt.input('Stop').fire).toHaveBeenCalledTimes(1);
    expect(rt.enums['state']?.value).toBe('idle');
    expect(rt.enums['poses']?.value).toBe('giggle');
  });

  it('连着勾完两次：还原按最后一次算，不提前改回', async () => {
    const { rt, load } = fakeRuntime(['Eye', 'Walk', 'Stop', 'Big']);
    stage = createStage(box(), def, {}, load);
    await loaded(rt);
    stage.react('done');
    await vi.advanceTimersByTimeAsync(600);
    stage.react('done');
    await vi.advanceTimersByTimeAsync(600);
    expect(rt.input('Eye').value).toBe(3);
    expect(rt.input('Stop').fire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(rt.input('Eye').value).toBe(4);
    expect(rt.input('Stop').fire).toHaveBeenCalledTimes(1);
  });

  it('短按（没有形态的）照新增演；没写的反应（删除）什么都不做；没载入好不演', async () => {
    const { rt, load } = fakeRuntime(['Eye', 'Walk', 'Stop', 'Big']);
    stage = createStage(box(), def, {}, load);
    stage.react('tap');
    expect(rt.input('Big').sets).toEqual([]);
    await loaded(rt);
    stage.react('tap');
    expect(rt.input('Big').value).toBe(true);
    await vi.advanceTimersByTimeAsync(900);
    expect(rt.input('Big').value).toBe(false);
    const before = rt.inputs.map((i) => i.sets.length);
    stage.react('del');
    expect(rt.inputs.map((i) => i.sets.length)).toEqual(before);
  });
});

const moodDef: MascotDef = {
  ...base,
  moods: { input: 'mood', ms: 500, ring: ['Idle', 'Happy', 'No', 'Mail', 'Sleep', 'Upset'], rest: 'Idle', on: { done: 'Happy', del: 'No', mail: 'Mail', sleep: 'Sleep' }, random: ['Idle', 'Happy', 'Upset'] },
};

describe('暂停和恢复', () => {
  it('离屏时不排空闲随机；回到屏幕内把要的表情再设一次，再过一轮随机间隔才换', async () => {
    const { rt, load } = fakeRuntime(['mood']);
    stage = createStage(box(), moodDef, {}, load);
    await loaded(rt);
    rt.opts?.onStateChange?.({ data: ['Idle'] });
    expect(rt.input('mood').sets).toEqual([1]);
    io?.([{ isIntersecting: false }]);
    expect(rt.pause).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(rt.input('mood').sets).toEqual([1]);
    io?.([{ isIntersecting: true }]);
    expect(rt.play).toHaveBeenCalledTimes(1);
    // kick：恢复时把 Idle 再设一次
    expect(rt.input('mood').sets).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(MOOD_RANDOM_MS[0] - 1);
    expect(rt.input('mood').sets).toEqual([1, 1]);
    await vi.advanceTimersByTimeAsync(1);
    // Math.random 固定 0：从 Idle 前后挑第一个 Happy（序号 2）
    expect(rt.input('mood').sets).toEqual([1, 1, 2]);
  });

  it('对照：一直在屏幕内，第一轮随机间隔到了就换', async () => {
    const { rt, load } = fakeRuntime(['mood']);
    stage = createStage(box(), moodDef, {}, load);
    await loaded(rt);
    rt.opts?.onStateChange?.({ data: ['Idle'] });
    await vi.advanceTimersByTimeAsync(MOOD_RANDOM_MS[0]);
    expect(rt.input('mood').sets).toEqual([1, 2]);
  });
});

describe('角色框建舞台时还没尺寸', () => {
  it('框是 0（WebKit 里吉祥物样式表还没套上）：画布先不定尺寸；框有了尺寸就按它摆好、重设绘图面，不停在 0', async () => {
    const obs = { fire: (): void => undefined };
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) {
        obs.fire = cb;
      }
      observe(): void {}
      disconnect(): void {}
    });
    const size = { w: 0, h: 0 };
    const el = box();
    Object.defineProperty(el, 'clientWidth', { get: () => size.w });
    Object.defineProperty(el, 'clientHeight', { get: () => size.h });
    const { rt, load } = fakeRuntime([]);
    stage = createStage(el, { ...base, size: [200, 100], crop: [0, 0, 100, 50] }, {}, load);
    const c = el.querySelector('canvas') as HTMLCanvasElement;
    expect(c.style.width).toBe('');
    await loaded(rt);
    // 框是 0：画布像素先不定、不画
    expect(rt.resized).toEqual([]);
    obs.fire();
    expect(c.style.width).toBe('');
    expect(rt.resized).toEqual([]);
    size.w = 132;
    size.h = 118;
    obs.fire();
    // s = min(132/100, 118/50) = 1.32：画布 264 × 132，水平居中、底边对齐
    expect(c.style.width).toBe('264px');
    expect(c.style.height).toBe('132px');
    expect(c.style.left).toBe('0px');
    expect(c.style.top).toBe('52px');
    // 画布像素按 stageBox 定（jsdom 像素比 1），不量 getBoundingClientRect
    expect([c.width, c.height]).toEqual([264, 132]);
    expect(rt.resized).toEqual([1]);
  });
});

describe('静态图先显示，Rive 第一帧换上', () => {
  const still: MascotDef = { ...base, still: 'x.still.webp', init: { Eye: 4 }, moods: moodDef.moods! };
  /** 静态图下载解码：ok() 交出解码好的图片，bad() 失败 */
  let decoded: { ok(): void; bad(): void };
  const withStill = <T extends { load: object }>(f: T): T & { load: { still(): Promise<HTMLImageElement> } } => ({
    ...f,
    load: {
      ...f.load,
      still: () =>
        new Promise<HTMLImageElement>((ok, bad) => {
          decoded = { ok: () => ok(document.createElement('img')), bad: () => bad(new Error('decode')) };
        }),
    },
  });
  const sized = (): HTMLElement => {
    const el = box();
    Object.defineProperty(el, 'clientWidth', { get: () => 132 });
    Object.defineProperty(el, 'clientHeight', { get: () => 118 });
    return el;
  };

  it('静态图解码好就显示、开始降落；Rive 第一帧有角色像素时同一帧换上画布、拿掉静态图，不再降落一次', async () => {
    const el = sized();
    const { rt, load } = withStill(fakeRuntime(['Eye', 'mood']));
    const cb = { onShown: vi.fn(), onStill: vi.fn(), onLive: vi.fn() };
    stage = createStage(el, still, cb, load);
    const c = el.querySelector('canvas') as HTMLCanvasElement;
    expect(el.querySelector('img')).toBeNull();
    decoded.ok();
    await vi.advanceTimersByTimeAsync(0);
    const img = el.querySelector('img') as HTMLImageElement;
    expect(el.firstChild).toBe(img);
    // 静态图和画布同一个位置、大小
    for (const k of ['left', 'top', 'width', 'height'] as const) expect(img.style[k]).toBe(c.style[k]);
    expect(img.style.opacity).toBe('1');
    expect(cb.onStill).toHaveBeenCalledTimes(1);
    expect(cb.onShown).toHaveBeenCalledTimes(1);
    expect(Element.prototype.animate).toHaveBeenCalledTimes(1);
    await loaded(rt);
    // 输入先设好再画第一帧（静态图是按这个顺序出的）
    expect(rt.firstDraw).toEqual({ Eye: 4, mood: 1 });
    expect(c.style.opacity).toBe('0');
    rt.opts?.onAdvance();
    await vi.advanceTimersByTimeAsync(0);
    expect(c.style.opacity).toBe('1');
    expect(img.isConnected).toBe(false);
    expect(cb.onLive).toHaveBeenCalledTimes(1);
    expect(cb.onShown).toHaveBeenCalledTimes(1);
    expect(Element.prototype.animate).toHaveBeenCalledTimes(1);
  });

  it('Rive 开头几帧透明：有角色像素那一帧才换，之前一直是静态图', async () => {
    const el = sized();
    const { rt, load } = withStill(fakeRuntime([]));
    stage = createStage(el, still, {}, load);
    decoded.ok();
    await loaded(rt);
    const img = el.querySelector('img') as HTMLImageElement;
    ink.on = false;
    for (let i = 0; i < 3; i++) rt.opts?.onAdvance();
    await vi.advanceTimersByTimeAsync(0);
    expect(img.isConnected).toBe(true);
    expect((el.querySelector('canvas') as HTMLCanvasElement).style.opacity).toBe('0');
    ink.on = true;
    rt.opts?.onAdvance();
    await vi.advanceTimersByTimeAsync(0);
    expect(img.isConnected).toBe(false);
  });

  it('框还是 0 时解码好了：先不显示（会按图片原尺寸撑开），框有了尺寸再显示', async () => {
    const obs = { fire: (): void => undefined };
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) {
        obs.fire = cb;
      }
      observe(): void {}
      disconnect(): void {}
    });
    const size = { w: 0, h: 0 };
    const el = box();
    Object.defineProperty(el, 'clientWidth', { get: () => size.w });
    Object.defineProperty(el, 'clientHeight', { get: () => size.h });
    const { load } = withStill(fakeRuntime([]));
    const onStill = vi.fn();
    stage = createStage(el, still, { onStill }, load);
    decoded.ok();
    await vi.advanceTimersByTimeAsync(0);
    const img = el.querySelector('img') as HTMLImageElement;
    expect(img.style.opacity).toBe('0');
    size.w = 132;
    size.h = 118;
    obs.fire();
    expect(img.style.opacity).toBe('1');
    expect(img.style.width).not.toBe('');
    expect(onStill).toHaveBeenCalledTimes(1);
  });

  it('静态图下载失败：拿掉，等 Rive 第一帧照旧显示、降落', async () => {
    const el = sized();
    const { rt, load } = withStill(fakeRuntime([]));
    const cb = { onShown: vi.fn(), onStill: vi.fn() };
    stage = createStage(el, still, cb, load);
    decoded.bad();
    await loaded(rt);
    expect(el.querySelector('img')).toBeNull();
    expect(cb.onShown).not.toHaveBeenCalled();
    rt.opts?.onAdvance();
    await vi.advanceTimersByTimeAsync(0);
    expect(cb.onShown).toHaveBeenCalledTimes(1);
    expect(cb.onStill).not.toHaveBeenCalled();
    expect((el.querySelector('canvas') as HTMLCanvasElement).style.opacity).toBe('1');
  });

  it('Rive 载入失败：已显示的静态图拿掉，失败以后才解码好的也不再放（设置页预览、AI 栏失败时画别的退路，不能叠在一起）', async () => {
    for (const order of ['shown-then-fail', 'fail-then-decoded'] as const) {
      const el = sized();
      const f = withStill(fakeRuntime([]));
      let reject: (e: Error) => void = () => undefined;
      const riv = (): Promise<ArrayBuffer> => new Promise((_ok, bad) => (reject = bad));
      const cb = { onFail: vi.fn(), onStill: vi.fn() };
      stage = createStage(el, still, cb, { ...f.load, riv });
      if (order === 'shown-then-fail') {
        decoded.ok();
        await vi.advanceTimersByTimeAsync(0);
        expect(el.querySelector('img')).not.toBeNull();
      }
      reject(new Error('riv'));
      await vi.advanceTimersByTimeAsync(0);
      if (order === 'fail-then-decoded') {
        decoded.ok();
        await vi.advanceTimersByTimeAsync(0);
        expect(cb.onStill).not.toHaveBeenCalled();
      }
      expect(cb.onFail).toHaveBeenCalledTimes(1);
      expect(el.querySelector('img')).toBeNull();
      stage.destroy();
      stage = null;
    }
  });

  it('Rive 一直看不出角色像素（整个半透明）：过了 120 帧照样换上画布，不至于永远不出来', async () => {
    const el = sized();
    const { rt, load } = fakeRuntime([]);
    const onShown = vi.fn();
    stage = createStage(el, base, { onShown }, load);
    await loaded(rt);
    ink.on = false;
    const c = el.querySelector('canvas') as HTMLCanvasElement;
    for (let i = 0; i < 119; i++) rt.opts?.onAdvance();
    await vi.advanceTimersByTimeAsync(0);
    expect([c.style.opacity, onShown.mock.calls.length]).toEqual(['0', 0]);
    rt.opts?.onAdvance();
    await vi.advanceTimersByTimeAsync(0);
    expect([c.style.opacity, onShown.mock.calls.length]).toEqual(['1', 1]);
  });

  it('Rive 比静态图先好：静态图不再显示', async () => {
    const el = sized();
    const { rt, load } = withStill(fakeRuntime([]));
    const onStill = vi.fn();
    stage = createStage(el, still, { onStill }, load);
    await loaded(rt);
    rt.opts?.onAdvance();
    await vi.advanceTimersByTimeAsync(0);
    decoded.ok();
    await vi.advanceTimersByTimeAsync(0);
    expect(el.querySelector('img')).toBeNull();
    expect(onStill).not.toHaveBeenCalled();
  });
});

describe('减少动态效果停帧', () => {
  it('一般角色：画出来那一帧就停', async () => {
    h.reduced = true;
    const { rt, load } = fakeRuntime([]);
    stage = createStage(box(), base, {}, load);
    await loaded(rt);
    expect(rt.pause).not.toHaveBeenCalled();
    rt.opts?.onAdvance();
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.pause).toHaveBeenCalledTimes(1);
  });

  it('带表情的：画出来了但表情没到不停；到了还要等转场走完（ms + 100）才停', async () => {
    h.reduced = true;
    const { rt, load } = fakeRuntime(['mood']);
    stage = createStage(box(), moodDef, {}, load);
    await loaded(rt);
    for (let i = 0; i < 10; i++) rt.opts?.onAdvance();
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.pause).not.toHaveBeenCalled();
    rt.opts?.onStateChange?.({ data: ['Idle'] });
    rt.opts?.onAdvance();
    await vi.advanceTimersByTimeAsync(500);
    rt.opts?.onAdvance();
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.pause).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    rt.opts?.onAdvance();
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.pause).toHaveBeenCalledTimes(1);
  });

  it('带表情的一直等不到表情：最多等 240 帧（STILL_MAX_FRAMES 的两倍）也停', async () => {
    h.reduced = true;
    const { rt, load } = fakeRuntime(['mood']);
    stage = createStage(box(), moodDef, {}, load);
    await loaded(rt);
    for (let i = 0; i < 239; i++) rt.opts?.onAdvance();
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.pause).not.toHaveBeenCalled();
    rt.opts?.onAdvance();
    await vi.advanceTimersByTimeAsync(0);
    expect(rt.pause).toHaveBeenCalledTimes(1);
  });
});

describe('看向和身子偏（Aldo，负责人 11-26 选“放大一半，点的时候身子也往那边偏一点”）', () => {
  const look: MascotDef = {
    ...base,
    look: { ptr: true, rest: [50, 50], toLocal: (x: number, y: number) => [x, y] as const, reach: 1000, box: [40, 30, 70, 60] },
    lean: 5,
  };
  /** 画布和角色框都量成 100×100、在 (0,0)：画布坐标 = 屏幕坐标 */
  const rect = (): void => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
  };

  it('指针点到很远：发给画布的位置夹在 box 里（素材感应范围外眼睛会回正）', async () => {
    rect();
    const { rt, load } = fakeRuntime([]);
    const el = box();
    stage = createStage(el, look as never, {}, load);
    await loaded(rt);
    const moves: [number, number][] = [];
    el.querySelector('canvas')?.addEventListener('mousemove', (e) => moves.push([e.clientX, e.clientY]));
    stage.lookAt(5000, -5000);
    await vi.advanceTimersByTimeAsync(2000);
    const lastMove = moves.at(-1);
    expect(lastMove?.[0]).toBeCloseTo(70, 0);
    expect(lastMove?.[1]).toBeCloseTo(30, 0);
    for (const [x, y] of moves) {
      expect(x).toBeLessThanOrEqual(70.01);
      expect(y).toBeGreaterThanOrEqual(29.99);
    }
  });

  it('带看向的角色也按 lean 往指针那边偏；2.6 秒没动回正', async () => {
    rect();
    const { rt, load } = fakeRuntime([]);
    const el = box();
    stage = createStage(el, look as never, {}, load);
    await loaded(rt);
    stage.lookAt(150, 50);
    await vi.advanceTimersByTimeAsync(1500);
    expect(el.style.transform).toBe('translate(5.0px,0.0px)');
    await vi.advanceTimersByTimeAsync(4000);
    expect(el.style.transform).toBe('translate(0.0px,0.0px)');
  });
});
