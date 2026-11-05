// 设置 › 皮肤 › 倾斜高光（TILT-b2 做法 ②，R-247；主持人 11-05：开关在设置页、存本机、默认关）
// • 打开：先在这次点按里申请方向数据权限（有 requestPermission 接口的才问：iOS，新版安卓 Chrome 也有；platform/motion-sensor.ts），同意了才记成开；拒绝就保持关、提示一句
// • 关掉：直接记成关，不涉及权限
// • 真正读方向、挪高光在底栏那边（motion/glass-tilt.ts，首屏后才下载）：底栏每次挂上时读这个开关；
//   这次打开里在这里同意过的，回到底栏直接跟（设计评审 T1）；授权记不住的（iOS）每次重新打开 App 后第一次点底栏再问一次
//   （不在设置页和底栏点按之外的地方弹窗）
import { useCallback, useState } from 'react';
import { askMotionPermission } from '../../../platform/motion-sensor.ts';
import { readTiltPref, writeTiltPref } from '../data/local.ts';

export type TiltNote = 'none' | 'denied';

export interface TiltDeps {
  ask?: () => Promise<boolean>;
  storage?: Storage;
}

export function useTiltPref(deps?: TiltDeps | undefined) {
  const [on, setOn] = useState(() => readTiltPref(deps?.storage));
  const [note, setNote] = useState<TiltNote>('none');
  const set = useCallback(
    (next: boolean): Promise<void> => {
      setNote('none');
      if (!next) {
        writeTiltPref(false, deps?.storage);
        setOn(false);
        return Promise.resolve();
      }
      // 权限要在点按里同步发起：ask() 在第一个 await 之前调用
      const asking = (deps?.ask ?? askMotionPermission)();
      return asking.then((ok) => {
        if (!ok) {
          setNote('denied');
          return;
        }
        setOn(writeTiltPref(true, deps?.storage));
      });
    },
    [deps?.ask, deps?.storage],
  );
  return { on, note, set };
}
