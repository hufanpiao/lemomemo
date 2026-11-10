// 麦克风被拒时今天页常驻一行（B3 S23、架构 5.9“权限状态”）：看 platform/perm-mic.ts 记下的麦克风结果
// • 先同步读记下的（lastMicResult），画出来不闪；再异步问一次 Permissions API（能答就以它为准，用户在系统里重新打开后这一行自己消失）
// • exe 不做语音（R-90）：一律 false
import { useEffect, useState } from 'react';
import { isTauri } from '../../../platform/env.ts';
import { lastMicResult, micPermission } from '../../../platform/perm-mic.ts';

export function useMicDenied(exe: boolean = isTauri()): boolean {
  const [denied, setDenied] = useState(() => !exe && lastMicResult() === 'denied');
  useEffect(() => {
    if (exe) return undefined;
    let live = true;
    void micPermission().then((s) => {
      if (live) setDenied(s === 'denied');
    });
    return () => {
      live = false;
    };
  }, [exe]);
  return denied;
}
