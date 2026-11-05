// 倾斜高光（TILT-b2 做法 ②，R-247；参数照试验页 皮肤-v4/液态玻璃-真机试验.html 第 2 版 onTilt / stepTilt）
// 由 glass-ghost.ts 的 startGlass 启动（主持人 11-05：倾斜监听放在首屏后才下载的副本引擎里，外壳不加代码；
// 监听本身写进 glass-ghost.ts 会超过 300 行代码的上限（max-lines），拆到这个文件，只有 glass-ghost.ts 引它，跟它一起首屏后才下载）
// • 开关：设置 › 皮肤 › 倾斜高光，本机 localStorage 的 lemo.tilt = '1' 才开，默认关（键名和 features/settings/data/local.ts 一样，测试核对）
// • 减少动态效果（系统或 data-rm）：不开；开着时中途打开减少动态效果，高光回到默认位置
// • 要授权的浏览器（有 DeviceOrientationEvent.requestPermission 的：iOS，新版安卓 Chrome 也有；只能在点按里弹窗）：
//   ① 底栏挂上时先不在点按里问一下（quietGranted）：这次打开里已经同意过（例如刚在设置页打开开关时同意）、或浏览器记着同意，
//      就直接听，不用再点底栏（设计评审 T1、T2；安卓先看 permissions 的 accelerometer、gyroscope 是不是 granted）；
//   ② 没同意过（iOS 授权记不住，R-247）：等这次打开 App 后第一次点底栏（click，算用户点按）再问一次；拒绝或一直没有读数就停在默认位置。
//   没有这个接口的直接听 deviceorientation
// • 横屏（设计评审 T5）：按 screen.orientation.angle 把读数换回“对着屏幕的左右、前后”（screenAxes）
// • 写法：左右歪（gamma，限 ±35°）挪高光横向位置和亮边方向，前后仰（beta，限 0～90°）挪纵向位置；每帧往目标靠 15%，靠够了就停帧
//   写 --g-sx、--g-sy（径向高光中心）、--g-hx（亮边横向方向 -1～1）到每块玻璃上，样式在 GlassBar.module.css 的 .glass、.glass::after
import { prefersReducedMotion } from './reduced.ts';

export const TILT_KEY = 'lemo.tilt';
/** 默认位置（没开、没读数时；和 CSS 里 var() 的后备值一样） */
export const TILT_HOME = { x: 22, y: -30 } as const;

/** 本机开关：读不到（隐私模式）算关 */
export function tiltEnabled(storage?: Storage): boolean {
  try {
    return (storage ?? localStorage).getItem(TILT_KEY) === '1';
  } catch {
    return false;
  }
}

/** 横屏换轴：把设备坐标的 gamma（左右）、beta（前后）换成对着屏幕看的左右、前后（angle 是 screen.orientation.angle） */
export function screenAxes(gamma: number, beta: number | null, angle: number): { g: number; b: number | null } {
  // 横屏时设备的前后轴对着屏幕的左右、设备的左右轴对着屏幕的前后；方向按 W3C 设备坐标（真机核对见设计评审 T4）
  switch (((angle % 360) + 360) % 360) {
    case 90:
      return { g: beta ?? 0, b: -gamma };
    case 270:
      return { g: -(beta ?? 0), b: gamma };
    case 180:
      return { g: -gamma, b: beta === null ? null : -beta };
    default:
      return { g: gamma, b: beta };
  }
}
const screenAngle = (): number => (typeof screen !== 'undefined' && typeof screen.orientation?.angle === 'number' ? screen.orientation.angle : 0);

/** 方向读数 → 高光中心目标（百分比） */
export function tiltTarget(gamma: number, beta: number | null): { x: number; y: number } {
  const g = Math.max(-35, Math.min(35, gamma));
  const b = Math.max(0, Math.min(90, beta ?? 45));
  return { x: 50 + g * 1.6, y: -30 + (45 - b) * 0.6 };
}

/** 亮边横向方向：高光在左边时亮边在左上（1），在右边时翻到右上（-1） */
export const tiltHx = (x: number): number => Math.max(-1, Math.min(1, (50 - x) / 40));

type AskFn = () => Promise<string>;
const askFn = (): AskFn | null => {
  if (typeof DeviceOrientationEvent === 'undefined') return null;
  const ask = (DeviceOrientationEvent as unknown as { requestPermission?: AskFn }).requestPermission;
  return typeof ask === 'function' ? ask.bind(DeviceOrientationEvent) : null;
};

/**
 * 不在点按里看一下是不是已经同意了：permissions 里 accelerometer、gyroscope 都是 granted（安卓 Chrome），或者 requestPermission
 * 不在点按里也直接回 'granted'（这次打开里同意过）。没同意过时 iOS 会拒绝（要点按）、Chromium 回 'prompt'，都算“还没有”，不记成拒绝
 */
async function quietGranted(ask: AskFn): Promise<boolean> {
  const q = typeof navigator !== 'undefined' && navigator.permissions ? navigator.permissions : null;
  if (q) {
    const state = (name: string): Promise<string> =>
      q.query({ name: name as PermissionName }).then(
        (r) => r.state,
        () => 'unknown',
      );
    if ((await Promise.all([state('accelerometer'), state('gyroscope')])).every((st) => st === 'granted')) return true;
  }
  try {
    return (await ask()) === 'granted';
  } catch {
    return false;
  }
}

/** 这一次打开 App 里问过的结果（底栏重挂、换页不重问；拒绝了这次就不再问，停在默认位置） */
let asked: 'granted' | 'denied' | null = null;
/** 测试用：当作重新打开 App */
export function resetTiltAsk(): void {
  asked = null;
}

export interface TiltHandle {
  stop(): void;
}

/** 开始听倾斜：targets 是要写高光变量的玻璃块；tapOn 上的第一次 click 是要授权的浏览器弹窗的时机。没开关或减少动态效果时什么都不做 */
export function startTilt(targets: readonly HTMLElement[], tapOn: readonly HTMLElement[]): TiltHandle {
  const none: TiltHandle = { stop: () => undefined };
  if (!tiltEnabled() || prefersReducedMotion()) return none;
  let cur: { x: number; y: number } = { ...TILT_HOME };
  let goal: { x: number; y: number } = { ...TILT_HOME };
  let raf = 0;
  let listening = false;
  let stopped = false;

  const paint = (): void => {
    for (const el of targets) {
      const s = el.style;
      s.setProperty('--g-sx', `${cur.x.toFixed(1)}%`);
      s.setProperty('--g-sy', `${cur.y.toFixed(1)}%`);
      s.setProperty('--g-hx', tiltHx(cur.x).toFixed(2));
    }
  };
  const clear = (): void => {
    for (const el of targets) for (const k of ['--g-sx', '--g-sy', '--g-hx']) el.style.removeProperty(k);
  };
  const step = (): void => {
    raf = 0;
    if (stopped) return;
    const nx = cur.x + (goal.x - cur.x) * 0.15;
    const ny = cur.y + (goal.y - cur.y) * 0.15;
    if (Math.abs(nx - cur.x) < 0.05 && Math.abs(ny - cur.y) < 0.05) return;
    cur = { x: nx, y: ny };
    paint();
    raf = requestAnimationFrame(step);
  };
  const onTilt = (e: DeviceOrientationEvent): void => {
    if (e.gamma === null) return;
    if (prefersReducedMotion()) {
      // 中途打开减少动态效果：回到默认位置，不再跟
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      cur = { ...TILT_HOME };
      goal = { ...TILT_HOME };
      clear();
      return;
    }
    const a = screenAxes(e.gamma, e.beta, screenAngle());
    goal = tiltTarget(a.g, a.b);
    if (raf === 0) raf = requestAnimationFrame(step);
  };
  const listen = (): void => {
    if (listening || stopped) return;
    listening = true;
    addEventListener('deviceorientation', onTilt);
  };
  const onTap = (): void => {
    const ask = askFn();
    if (!ask || asked !== null) return;
    asked = 'denied'; // 先记上，连点不会问两次
    ask()
      .then((r) => {
        asked = r === 'granted' ? 'granted' : 'denied';
        if (asked === 'granted') listen();
      })
      .catch(() => undefined); // 不在点按里（不该发生）或浏览器拒绝：停在默认位置
  };

  const ask = askFn();
  if (!ask || asked === 'granted') listen();
  else if (asked === null) {
    for (const el of tapOn) el.addEventListener('click', onTap);
    void quietGranted(ask).then((ok) => {
      if (!ok || asked !== null) return;
      asked = 'granted';
      listen();
    });
  }

  return {
    stop(): void {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      removeEventListener('deviceorientation', onTilt);
      for (const el of tapOn) el.removeEventListener('click', onTap);
      clear();
    },
  };
}
