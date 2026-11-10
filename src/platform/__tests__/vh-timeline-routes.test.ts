// 冷启动时间线补记（platform/vh-timeline.ts，R-371 11-10 复审）：换路由一行（文档高、body 高、inner、vv、底栏下沿、挂着的页面）；
// inner / vv 一变立刻一行（离最近一次换路由多少 ms、挂着的页面）；切到日历后 2 秒内按帧记日历根和翻页容器（只记有变化的帧）
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CAL_WATCH_MS, calSig, pagesOf, readTimeline, startVhTimeline, TICK_MS } from '../vh-timeline.ts';

function frames() {
  const q: Array<() => void> = [];
  return {
    frame: (cb: () => void) => q.push(cb),
    flush(n: number) {
      for (let k = 0; k < n; k++) q.shift()?.();
    },
    get size() {
      return q.length;
    },
  };
}
const page = (feature: string): HTMLElement => {
  const m = document.createElement('main');
  m.dataset['feature'] = feature;
  document.body.append(m);
  return m;
};
/** 进日历：换地址（App 用 pushState，不发 hashchange）、换上日历页（带翻页容器） */
const toCalendar = (): HTMLElement => {
  history.pushState(null, '', '#/calendar');
  document.body.replaceChildren();
  const m = page('calendar');
  const pager = document.createElement('div');
  pager.dataset['testid'] = 'cal-pager';
  m.append(pager);
  return pager;
};
const microtask = () => new Promise<void>((r) => queueMicrotask(r));
const tl = (): string[] => {
  stop?.();
  return readTimeline().split('\n');
};

let inner = 895;
let stop: (() => void) | undefined;
beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  history.replaceState(null, '', '#/today');
  inner = 895;
  vi.spyOn(window, 'innerHeight', 'get').mockImplementation(() => inner);
  page('today');
});
afterEach(() => {
  stop?.();
  stop = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('换路由', () => {
  it('开头记一行当前路由；pushState 换到日历、DOM 一变就记 route->，带文档高、body 高、inner、vv、底栏下沿、挂着的页面', async () => {
    stop = startVhTimeline(frames().frame);
    toCalendar();
    await microtask();
    const out = tl();
    expect(out.find((l) => l.includes(' route= '))).toMatch(/route= #\/today docH=\d+ bodyH=\d+ inner=895 vv=\S+ bar=- page=today$/);
    expect(out.find((l) => l.includes('route->'))).toMatch(/route-> #\/calendar \(from #\/today\) docH=\d+ bodyH=\d+ inner=895 vv=\S+ bar=- page=calendar$/);
    expect(out.at(-1)).toMatch(/routes=1$/);
  });

  it('没有 DOM 变动（只换地址）：下一个 tick 也能核出来；同一路由不重复记', async () => {
    stop = startVhTimeline(frames().frame);
    history.pushState(null, '', '#/todos');
    vi.advanceTimersByTime(TICK_MS * 3);
    await microtask();
    expect(tl().filter((l) => l.includes('route->'))).toHaveLength(1);
  });

  it('pagesOf：切页途中新旧两个页面都在时用 + 连起来，没有写 -', () => {
    page('calendar');
    expect(pagesOf(document)).toBe('today+calendar');
    document.body.replaceChildren();
    expect(pagesOf(document)).toBe('-');
  });
});

describe('可见高度变化', () => {
  it('inner 一变（resize）立刻记 vh-change：变前变后、离最近一次换路由多少 ms、当时的路由和页面', async () => {
    stop = startVhTimeline(frames().frame);
    toCalendar();
    await microtask();
    vi.advanceTimersByTime(120);
    inner = 956;
    window.dispatchEvent(new Event('resize'));
    const line = tl().find((l) => l.includes('vh-change'));
    expect(line).toMatch(/vh-change inner=895->956 vv=\S+->\S+ since-route=120ms route=#\/calendar page=calendar bar=-$/);
  });

  it('还没换过路由时写 since-start；没变不记', () => {
    stop = startVhTimeline(frames().frame);
    window.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(300);
    inner = 956;
    window.dispatchEvent(new Event('resize'));
    const lines = tl().filter((l) => l.includes('vh-change'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/since-start=300ms route=#\/today/);
  });
});

describe(`切到日历后 ${CAL_WATCH_MS}ms 按帧记`, () => {
  it('只记有变化的帧：根和翻页容器的高、scrollHeight、transform、overflow-y；到点不再等帧', async () => {
    const f = frames();
    stop = startVhTimeline(f.frame);
    const pager = toCalendar();
    await microtask();
    f.flush(3);
    pager.style.transform = 'translateX(-10px)';
    vi.advanceTimersByTime(16);
    f.flush(2);
    vi.advanceTimersByTime(CAL_WATCH_MS);
    f.flush(5);
    expect(f.size).toBe(0);
    const cal = tl().filter((l) => / cal \+\d+ms /.test(l));
    expect(cal).toHaveLength(2);
    expect(cal[0]).toMatch(/cal \+0ms root=h\d+\/sh\d+\/tf:\S+\/ov:\S* pager=h\d+\/sh\d+\/tf:none\/ov:\S* docH=\d+$/);
    expect(cal[1]).toMatch(/cal \+16ms .*pager=h\d+\/sh\d+\/tf:translateX\(-10px\)/);
  });

  it('calSig：不在日历页时两项都写 -', () => {
    document.body.replaceChildren();
    expect(calSig(window)).toMatch(/^root=- pager=- docH=\d+$/);
  });

  it('冷启动就在日历：一开始就盯', () => {
    toCalendar();
    const f = frames();
    stop = startVhTimeline(f.frame);
    f.flush(1);
    expect(tl().some((l) => / cal \+0ms root=h/.test(l))).toBe(true);
  });
});
