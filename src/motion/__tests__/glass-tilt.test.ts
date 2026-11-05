// 倾斜高光（TILT-b2 做法 ②）：开关默认关；减少动态效果不开；要授权的浏览器：已同意（这次打开里同意过、permissions 是 granted）直接听，
// 没同意过的第一次点底栏才弹窗、一次打开只问一次（设计评审 T1、T2）；横屏换轴（T5）；读数往目标靠、写高光变量
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TILT_HOME, TILT_KEY, resetTiltAsk, screenAxes, startTilt, tiltEnabled, tiltHx, tiltTarget } from '../glass-tilt.ts';

/** 假的帧：手动推进 */
let frames: Array<FrameRequestCallback> = [];
const runFrames = (n: number): void => {
  for (let k = 0; k < n; k++) {
    const fs = frames;
    frames = [];
    for (const f of fs) f(performance.now());
  }
};

const orient = (gamma: number | null, beta: number | null): void => {
  const e = new Event('deviceorientation') as Event & { gamma: number | null; beta: number | null };
  Object.assign(e, { gamma, beta });
  dispatchEvent(e);
};

/** 正在点按里（click 处理中）：假的 requestPermission 用它分“点按里弹窗”和“不在点按里问” */
let tapping = false;
const markTap = (): void => {
  tapping = true;
  queueMicrotask(() => (tapping = false));
};
/**
 * 装一个假的 DeviceOrientationEvent.requestPermission（iOS、新版安卓 Chrome）：在点按里回 answer；不在点按里回 quiet
 * （默认像 iOS 没同意过：拒绝“要点按”；Chromium 是 'prompt'；这次打开里已经同意过的回 'granted'）
 */
const fakeIos = (answer: string | Error, quiet: string | Error = new Error('requires a user gesture')) => {
  const ask = vi.fn(() => {
    const a = tapping ? answer : quiet;
    return a instanceof Error ? Promise.reject(a) : Promise.resolve(a);
  });
  vi.stubGlobal('DeviceOrientationEvent', Object.assign(function DeviceOrientationEvent() {}, { requestPermission: ask }));
  return ask;
};

let bar: HTMLElement;
const stops: Array<() => void> = [];
const start = () => {
  const t = startTilt([bar], [bar]);
  stops.push(() => t.stop());
  return t;
};

beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (f: FrameRequestCallback) => (frames.push(f), frames.length));
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  bar = document.createElement('nav');
  document.body.append(bar);
  localStorage.clear();
  delete document.documentElement.dataset['rm'];
  resetTiltAsk();
  tapping = false;
  addEventListener('click', markTap, true);
});
afterEach(() => {
  removeEventListener('click', markTap, true);
  for (const s of stops.splice(0)) s();
  bar.remove();
  localStorage.clear();
  delete document.documentElement.dataset['rm'];
  vi.unstubAllGlobals();
});

describe('倾斜高光的换算（照试验页第 2 版）', () => {
  it('左右歪 ±35° 封顶，前后仰 0～90° 封顶；端平、仰 45° 时在正中偏上', () => {
    expect(tiltTarget(0, 45)).toEqual({ x: 50, y: -30 });
    expect(tiltTarget(35, 45).x).toBeCloseTo(106);
    expect(tiltTarget(90, 45)).toEqual(tiltTarget(35, 45));
    expect(tiltTarget(-90, 200)).toEqual(tiltTarget(-35, 90));
    expect(tiltTarget(0, null)).toEqual({ x: 50, y: -30 });
    expect(tiltHx(10)).toBe(1);
    expect(tiltHx(90)).toBe(-1);
    expect(tiltHx(50)).toBe(0);
  });

  it('横屏换轴（T5）：竖屏照原样；90° 用前后读数当左右；270° 反过来；倒拿（180°）左右前后都反', () => {
    expect(screenAxes(20, 50, 0)).toEqual({ g: 20, b: 50 });
    expect(screenAxes(-45, 20, 90)).toEqual({ g: 20, b: 45 });
    expect(screenAxes(45, 20, 270)).toEqual({ g: -20, b: 45 });
    expect(screenAxes(45, 20, -90)).toEqual(screenAxes(45, 20, 270));
    expect(screenAxes(20, -45, 180)).toEqual({ g: -20, b: 45 });
    expect(screenAxes(20, null, 90)).toEqual({ g: 0, b: -20 });
  });
});

describe('startTilt', () => {
  it('默认关（没开关）：不听方向，不写变量', () => {
    expect(tiltEnabled()).toBe(false);
    start();
    orient(30, 45);
    runFrames(5);
    expect(bar.style.getPropertyValue('--g-sx')).toBe('');
  });

  it('开着（不用授权的平台）：读数来了，每帧往目标靠 15%，写 --g-sx / --g-sy / --g-hx；停掉清掉变量', () => {
    localStorage.setItem(TILT_KEY, '1');
    const t = start();
    orient(35, 45); // 目标 x=106
    runFrames(1);
    const x1 = parseFloat(bar.style.getPropertyValue('--g-sx'));
    expect(x1).toBeCloseTo(TILT_HOME.x + (106 - TILT_HOME.x) * 0.15, 1);
    runFrames(200);
    expect(parseFloat(bar.style.getPropertyValue('--g-sx'))).toBeGreaterThan(105);
    expect(bar.style.getPropertyValue('--g-hx')).toBe('-1.00');
    expect(frames).toHaveLength(0); // 靠够了就停帧
    t.stop();
    expect(bar.style.getPropertyValue('--g-sx')).toBe('');
    orient(-20, 45);
    runFrames(3);
    expect(bar.style.getPropertyValue('--g-sx')).toBe('');
  });

  it('减少动态效果：开着也不听；中途打开减少动态效果，高光回到默认位置', () => {
    localStorage.setItem(TILT_KEY, '1');
    document.documentElement.dataset['rm'] = '1';
    start();
    orient(30, 45);
    runFrames(3);
    expect(bar.style.getPropertyValue('--g-sx')).toBe('');
    for (const s of stops.splice(0)) s();
    delete document.documentElement.dataset['rm'];
    start();
    orient(30, 45);
    runFrames(3);
    expect(bar.style.getPropertyValue('--g-sx')).not.toBe('');
    document.documentElement.dataset['rm'] = '1';
    orient(30, 45);
    expect(bar.style.getPropertyValue('--g-sx')).toBe('');
  });

  it('没同意过（iOS）：挂上时不在点按里问被拒、不弹窗也不算拒绝；第一次点底栏才弹窗，同意了才听；连点、底栏重挂都不再问', async () => {
    localStorage.setItem(TILT_KEY, '1');
    const ask = fakeIos('granted');
    start();
    await Promise.resolve();
    await Promise.resolve();
    orient(30, 45);
    runFrames(2);
    expect(ask).toHaveBeenCalledTimes(1); // 挂上时那一次（不在点按里，被拒）
    expect(bar.style.getPropertyValue('--g-sx')).toBe('');
    bar.click();
    bar.click();
    expect(ask).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    await Promise.resolve();
    orient(30, 45);
    runFrames(2);
    expect(bar.style.getPropertyValue('--g-sx')).not.toBe('');
    for (const s of stops.splice(0)) s();
    start(); // 换页底栏重挂：这次打开 App 已经同意过，直接听
    orient(-30, 45);
    runFrames(2);
    expect(bar.style.getPropertyValue('--g-sx')).not.toBe('');
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it('这次打开里已经同意过（例如刚在设置页打开开关时同意，T1）：底栏挂上就听，不用点', async () => {
    localStorage.setItem(TILT_KEY, '1');
    fakeIos('granted', 'granted');
    start();
    await Promise.resolve();
    await Promise.resolve();
    orient(30, 45);
    runFrames(2);
    expect(bar.style.getPropertyValue('--g-sx')).not.toBe('');
  });

  it('Chromium 没同意过（不在点按里回 prompt）：不听、不记成拒绝；点底栏同意后听', async () => {
    localStorage.setItem(TILT_KEY, '1');
    const ask = fakeIos('granted', 'prompt');
    start();
    await Promise.resolve();
    await Promise.resolve();
    orient(30, 45);
    runFrames(2);
    expect(bar.style.getPropertyValue('--g-sx')).toBe('');
    bar.click();
    expect(ask).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    await Promise.resolve();
    orient(30, 45);
    runFrames(2);
    expect(bar.style.getPropertyValue('--g-sx')).not.toBe('');
  });

  it('permissions 里 accelerometer、gyroscope 都是 granted（安卓记着同意，T2）：直接听；只有一个 granted 不算', async () => {
    localStorage.setItem(TILT_KEY, '1');
    for (const [gyro, on] of [['granted', true], ['prompt', false]] as const) {
      resetTiltAsk();
      fakeIos('granted', 'prompt');
      const query = vi.fn(({ name }: { name: string }) => Promise.resolve({ state: name === 'accelerometer' ? 'granted' : gyro }));
      vi.stubGlobal('navigator', { ...navigator, permissions: { query } });
      start();
      for (let k = 0; k < 6; k++) await Promise.resolve();
      orient(30, 45);
      runFrames(2);
      expect(bar.style.getPropertyValue('--g-sx') !== '', `gyroscope=${gyro}`).toBe(on);
      for (const s of stops.splice(0)) s();
    }
  });

  it('横屏（screen.orientation.angle=90）：按换轴后的左右算高光', async () => {
    localStorage.setItem(TILT_KEY, '1');
    vi.stubGlobal('screen', { orientation: { angle: 90 } });
    start();
    orient(-45, 35); // 横屏里往右歪：前后读数 35 → 屏幕左右 35，目标 x=106
    runFrames(300);
    expect(parseFloat(bar.style.getPropertyValue('--g-sx'))).toBeGreaterThan(105);
  });

  it('iOS 拒绝或抛错：停在默认位置，这次打开 App 不再问', async () => {
    localStorage.setItem(TILT_KEY, '1');
    for (const answer of ['denied', new Error('not a gesture')]) {
      resetTiltAsk();
      const ask = fakeIos(answer);
      start();
      await Promise.resolve();
      bar.click();
      await Promise.resolve();
      await Promise.resolve();
      orient(30, 45);
      runFrames(2);
      expect(bar.style.getPropertyValue('--g-sx')).toBe('');
      for (const s of stops.splice(0)) s();
      start();
      bar.click();
      expect(ask).toHaveBeenCalledTimes(2); // 挂上时不在点按里那一次 + 点按里那一次；拒绝后重挂不再问
      await Promise.resolve();
      for (const s of stops.splice(0)) s();
    }
  });
});
