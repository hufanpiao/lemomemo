// 底栏偏高冷启动时间线（platform/vh-timeline.ts，R-371 11-10）：开关只跑一次；每 250ms 一行六项数；底栏每次新挂载记 10 帧，做法按 none → scrollTo → scrollBy1 循环；3 分钟停、结果存本机
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ARM_KEY,
  DURATION_MS,
  MOUNT_FRAMES,
  OUT_KEY,
  readTimeline,
  routeShape,
  sampleLine,
  setTimelineArmed,
  startVhTimeline,
  TICK_MS,
  timelineArmed,
} from "../vh-timeline.ts";

/** 手动推进的“帧” */
function frames() {
  const q: Array<() => void> = [];
  return {
    frame: (cb: () => void) => q.push(cb),
    flush(n: number) {
      for (let k = 0; k < n; k++) q.shift()?.();
    },
  };
}

const mountBar = (): HTMLElement => {
  const el = document.createElement("nav");
  el.dataset["testid"] = "tabbar";
  document.body.append(el);
  return el;
};
const tick = () => new Promise<void>((r) => queueMicrotask(r));

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
  window.location.hash = "#/today";
});
const stops: Array<() => void> = [];
const start = (f: ReturnType<typeof frames>) => {
  const stop = startVhTimeline(f.frame);
  stops.push(stop);
  return stop;
};
afterEach(() => {
  for (const s of stops.splice(0)) s();
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("开关", () => {
  it("开、关存在本机；本机存储抛错时当没开、不抛", () => {
    expect(timelineArmed()).toBe(false);
    setTimelineArmed(true);
    expect(localStorage.getItem(ARM_KEY)).toBe("1");
    expect(timelineArmed()).toBe(true);
    setTimelineArmed(false);
    expect(timelineArmed()).toBe(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(timelineArmed()).toBe(false);
    expect(readTimeline()).toBe("");
  });

  it("main.tsx 读的键名就是 ARM_KEY，并且只在非正式版里读", () => {
    const main = readFileSync(resolve(__dirname, "../../app/main.tsx"), "utf8");
    expect(main).toContain(`localStorage.getItem('${ARM_KEY}')`);
    expect(main).toMatch(
      /import\.meta\.env\.MODE !== 'production'\) \{\s*try \{\s*if \(localStorage\.getItem\('lemo-vh-tl'\)\) void import\('\.\.\/platform\/vh-diag-boot\.ts'\)/,
    );
  });
});

describe("startVhTimeline", () => {
  it("一开始就关掉开关（只跑一次），并马上存下表头", () => {
    setTimelineArmed(true);
    const f = frames();
    const stop = start(f);
    expect(timelineArmed()).toBe(false);
    const out = readTimeline();
    expect(out.split("\n")[0]).toMatch(
      /^vh-timeline start=\S+ screen=\d+x\d+ tick=250ms dur=180s$/,
    );
    expect(out).toMatch(
      /initial-bar=no inner=\d+ client=\d+ vv=\S+ y=0 bar=- route=#\/today/,
    );
    stop();
  });

  it("每 250ms 一行，带底栏下沿和路由；3 分钟停，最后一行 end", () => {
    const bar = mountBar();
    vi.spyOn(bar, "getBoundingClientRect").mockReturnValue({
      bottom: 900.4,
    } as DOMRect);
    const f = frames();
    start(f);
    // 每 2 秒存一次本机：8 格以后能读到 8 行
    vi.advanceTimersByTime(TICK_MS * 8);
    let out = readTimeline().split("\n");
    expect(out.filter((l) => /^t=\d+\.\d\d inner=/.test(l))).toHaveLength(8);
    expect(out.at(-1)).toMatch(/bar=900 route=#\/today$/);
    vi.advanceTimersByTime(DURATION_MS);
    out = readTimeline().split("\n");
    expect(out.at(-1)).toMatch(/^t=180\.00 end mounts=0 routes=0$/);
    expect(
      out.filter((l) => / inner=/.test(l) && !l.includes("initial-bar") && !l.includes(" route= ")),
    ).toHaveLength(DURATION_MS / TICK_MS);
    // 停了以后不再记
    vi.advanceTimersByTime(TICK_MS * 8);
    expect(readTimeline().split("\n").at(-1)).toMatch(/end mounts=0 routes=0$/);
  });

  it("开始时已经挂着的底栏不算新挂载；之后每次新挂载记 10 帧，做法按 none、scrollTo、scrollBy1、none 循环", async () => {
    const first = mountBar();
    // jsdom 的 scrollTo、scrollBy 是同一个函数，分别换成两个假函数才数得清
    const scrollTo = vi.fn();
    const scrollBy = vi.fn();
    Object.defineProperty(window, "scrollTo", {
      value: scrollTo,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(window, "scrollBy", {
      value: scrollBy,
      configurable: true,
      writable: true,
    });
    const f = frames();
    start(f);
    await tick();
    expect(readTimeline()).toContain("initial-bar=yes");
    const acts: string[] = [];
    let prev = first;
    for (let k = 0; k < 4; k++) {
      prev.remove();
      await tick();
      prev = mountBar();
      await tick();
      f.flush(MOUNT_FRAMES);
      const line = readTimeline().split("\n").at(-1) ?? "";
      expect(line).toMatch(
        new RegExp(
          `^t=\\S+ mount#${k + 1} inner=\\d+ client=\\d+ vv=\\S+ y=0 bar=0 route=#/today act=\\w+\\(y=0\\) f0=0 frames=(0,){9}0$`,
        ),
      );
      acts.push(/act=(\w+)/.exec(line)?.[1] ?? "");
    }
    expect(acts).toEqual(["none", "scrollTo", "scrollBy1", "none"]);
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    // scrollBy1：先滚 1px，第一帧记完再滚回原处
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith(0, 1);
    expect(scrollTo).toHaveBeenCalledTimes(2);
  });

  it("定时器停过（iOS 切后台）也按经过的时间停：过了 3 分钟的下一跳就停（代码审 S1）", () => {
    const f = frames();
    start(f);
    vi.advanceTimersByTime(TICK_MS * 2);
    // 只拨钟、不跑定时器：模拟后台里定时器停了 3 分钟
    vi.setSystemTime(Date.now() + DURATION_MS);
    vi.advanceTimersByTime(TICK_MS);
    const out = readTimeline().split("\n");
    expect(out.at(-1)).toMatch(/^t=180\.\d\d end mounts=0 routes=0$/);
    expect(out.filter((l) => /^t=\S+ inner=/.test(l))).toHaveLength(3);
  });

  it("停了以后底栏再挂载、再过时间，都不再记（代码审 S2）", async () => {
    const f = frames();
    const stop = start(f);
    stop();
    const before = readTimeline();
    expect(before.split("\n").at(-1)).toMatch(/end mounts=0 routes=0$/);
    mountBar();
    await tick();
    f.flush(MOUNT_FRAMES);
    vi.advanceTimersByTime(TICK_MS * 8);
    expect(readTimeline()).toBe(before);
    expect(readTimeline()).not.toContain("mount#");
  });

  it("切到后台时记一行并存下；本机存储写不进也不抛", () => {
    const f = frames();
    start(f);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(readTimeline().split("\n").at(-1)).toMatch(/^t=\S+ hidden$/);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => vi.advanceTimersByTime(DURATION_MS)).not.toThrow();
    expect(localStorage.getItem(OUT_KEY)).toMatch(/hidden$/);
  });
});

describe("routeShape（代码审 S3）", () => {
  it("路径里的 id 换成 :id，页名和日期留着", () => {
    expect(routeShape("#/todo/0e2e0000-0000-4000-8000-000000000001")).toBe("#/todo/:id");
    expect(routeShape("#/event/AbCdEf0123456789xyz/edit")).toBe("#/event/:id/edit");
    expect(routeShape("#/calendar/2026-11-10")).toBe("#/calendar/2026-11-10");
    expect(routeShape("#/todo/new")).toBe("#/todo/new");
    expect(routeShape("#/settings")).toBe("#/settings");
    expect(routeShape("")).toBe("#");
  });

  it("写进时间线的那一行也是换过的", () => {
    window.location.hash = "#/todo/0e2e0000-0000-4000-8000-000000000001";
    expect(sampleLine(window)).toMatch(/ route=#\/todo\/:id$/);
  });
});

describe("sampleLine", () => {
  it("没有底栏写 bar=-；路由为空写 #", () => {
    window.location.hash = "";
    expect(sampleLine(window)).toMatch(
      /^inner=\d+ client=\d+ vv=\S+ y=0 bar=- route=#$/,
    );
  });
});
