// 麦克风权限状态（架构 5.9“权限状态”，B3 S23）。和 perm.ts 分开放：提醒那边引 perm.ts，设置、今天页引这里，共用一个文件会被拆成独立块，首屏主块的依赖表多一项（B3 FA-4 实测）
// • 麦克风（B3 S23，架构审 M7）：iOS 不一定支持 Permissions API 的 'microphone'，所以录音时把 getUserMedia 的结果记下来
//   （rememberMicResult，录音那边调）；读的时候能问到 Permissions API 就以它为准，问不到用记下的，都没有是 'unknown'
//   记在 localStorage（设备上的权限，不跟账号走，退出登录也不清）；存不进、读不出都当没记过
// • exe 不做语音（R-90）：exe 里不调这些麦克风函数，界面也不显示麦克风这一行
export type MicState = 'granted' | 'denied' | 'unknown';
export const MIC_PERM_KEY = 'lemo.mic_perm';

function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

/** 录音时 getUserMedia 的结果：成功 'granted'；NotAllowedError / SecurityError 'denied'；别的错（没有麦克风等）不记 */
export function micResultOf(err: unknown): 'granted' | 'denied' | null {
  if (err === null || err === undefined) return 'granted';
  const name = typeof err === 'object' && 'name' in err ? (err as { name: unknown }).name : null;
  return name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError' ? 'denied' : null;
}

export function rememberMicResult(v: 'granted' | 'denied'): void {
  try {
    storage()?.setItem(MIC_PERM_KEY, v);
  } catch {
    // 存不进（隐私模式、满了）：这次不记
  }
}

/** 只看记下的（同步，给首屏外的界面先画一版） */
export function lastMicResult(): MicState {
  try {
    const v = storage()?.getItem(MIC_PERM_KEY);
    return v === 'granted' || v === 'denied' ? v : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 麦克风现在的状态：Permissions API 能答就以它为准（granted / denied 顺手记下，prompt 清掉记录）；问不到时用记下的 */
export async function micPermission(): Promise<MicState> {
  try {
    const q = typeof navigator !== 'undefined' ? navigator.permissions?.query : undefined;
    if (typeof q === 'function') {
      const s = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      if (s.state === 'granted' || s.state === 'denied') {
        rememberMicResult(s.state);
        return s.state;
      }
      // 'prompt'：用户在系统里重置过，以前记的作废
      // FA-3 上真机时验证（S23 代码审建议 2）：iPhone 主屏幕版每次会话开始常返回 'prompt'，这里会清掉记下的“已拒绝”，
      // 今天页“麦克风被拒”那一行可能一直出不来；要不要改成 prompt 时保留记录，真机看过再定
      storage()?.removeItem(MIC_PERM_KEY);
      return 'unknown';
    }
  } catch {
    // Safari 旧版不认 'microphone'：用记下的
  }
  return lastMicResult();
}
