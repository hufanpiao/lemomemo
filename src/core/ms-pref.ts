// PPT 预览交不交给微软：每台设备第一次问一次，选择记在本机（R-114 D-6；线框 sPrev 第二张“这台设备只问一次，可以在 设置 › 数据 里改”）
// • 普通随手记、隐私记各记一份（隐私记的文件要先解密再交给微软，同意普通的不等于同意隐私记的，B4b-1 代定）
// • 只是“预览 / 只下载”两个值，不是用户内容，放 localStorage；读写不了（隐私模式等）就当没选过，下次再问
// • 附件预览浮层读写、设置 › 数据 改或清掉（改回“先问”）。放 core：两个功能都要用，功能之间不互相引内部文件
// 纯 TS：不准 import React（A1）
export type MsScope = 'note' | 'vault';
export type MsPref = 'yes' | 'no';

export const MS_PREF_KEYS: Readonly<Record<MsScope, string>> = { note: 'att.ms_preview', vault: 'att.ms_preview_vault' };

export function readMsPref(scope: MsScope): MsPref | null {
  try {
    const v = localStorage.getItem(MS_PREF_KEYS[scope]);
    return v === 'yes' || v === 'no' ? v : null;
  } catch {
    return null;
  }
}

/** null = 清掉（下次再问） */
export function writeMsPref(scope: MsScope, v: MsPref | null): void {
  try {
    if (v === null) localStorage.removeItem(MS_PREF_KEYS[scope]);
    else localStorage.setItem(MS_PREF_KEYS[scope], v);
  } catch {
    // 记不下就下次再问
  }
}
