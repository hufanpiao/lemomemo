// PPT 预览交不交给微软：每台设备第一次问一次，选择记在本机（R-114 D-6；线框 sPrev 第二张“这台设备只问一次”）
// 只是“预览 / 只下载”两个值，不是用户内容，放 localStorage；读写不了（隐私模式等）就当没选过，下次再问
// 纯 TS：不准 import React（A1）
export const MS_PREF_KEY = 'att.ms_preview';
export type MsPref = 'yes' | 'no';

export function readMsPref(): MsPref | null {
  try {
    const v = localStorage.getItem(MS_PREF_KEY);
    return v === 'yes' || v === 'no' ? v : null;
  } catch {
    return null;
  }
}

export function writeMsPref(v: MsPref): void {
  try {
    localStorage.setItem(MS_PREF_KEY, v);
  } catch {
    // 记不下就下次再问
  }
}
