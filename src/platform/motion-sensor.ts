// 手机方向数据的权限（TILT-b2 做法 ②，R-247；设置 › 皮肤 的“倾斜高光”开关用）
// • 有 DeviceOrientationEvent.requestPermission 的浏览器（iOS 13 起，新版安卓 Chrome 也有）读 deviceorientation 要先调它，弹窗只能在用户点按里；
//   这个函数第一步就同步调它（await 之前），放在开关的 onChange 里调用即可算作点按里
// • 没有这个接口（老安卓、电脑）：不用授权，直接返回 true（有没有读数由底栏那边看，收不到就停在默认位置）
// • 这次打开里同意过的，底栏挂上就直接跟（motion/glass-tilt.ts 不在点按里问一下）；iOS 授权“记不住”（R-247 实测）：每次重新打开 App 后第一次点底栏时再问一次（motion 不能引 platform，那边自己写）
type AskFn = () => Promise<'granted' | 'denied' | string>;

/** 当前环境要不要先授权才能读方向数据（有 requestPermission 接口的：iOS Safari / 主屏幕版、新版安卓 Chrome） */
function askFn(): AskFn | null {
  if (typeof DeviceOrientationEvent === 'undefined') return null;
  const ask = (DeviceOrientationEvent as unknown as { requestPermission?: AskFn }).requestPermission;
  return typeof ask === 'function' ? ask.bind(DeviceOrientationEvent) : null;
}

/** 申请读方向数据：不用授权或同意了返回 true；拒绝、抛错（不在点按里调）返回 false */
export async function askMotionPermission(): Promise<boolean> {
  const ask = askFn();
  if (!ask) return true;
  try {
    return (await ask()) === 'granted';
  } catch {
    return false;
  }
}
