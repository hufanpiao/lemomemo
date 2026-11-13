// 设置 › 皮肤 的读写（ADR-008；R-06 跟随系统 / 浅色 / 深色三选一、R-20 两套皮肤、R-84 减少透明效果、R-93 减少动态效果）：
// 四个键按账号存（platform/look.ts）；写经 kit 的 useSettingWriter（进 outbox、本机集合先变），<html> 上的属性由 platform/look.ts 的 watchLook 盯着 settings 集合去改。
// 设置 › 字体 同用这一个（ui.font 存 {v: 1, id}，编码 lookValue 和解码 lookOf 都在 platform/look.ts）
import { useCallback, useState } from 'react';
import { useSettingWriter } from '../../../kit/hooks/useSettingWriter.ts';
import { thisDeviceKind } from '../../../platform/device-kind.ts';
import { LOOK_KEYS, lookOfRows, lookValue, type Look } from '../../../platform/look.ts';

export function useLookSetting(newId: () => string = () => crypto.randomUUID()) {
  const { rows, save, error } = useSettingWriter(newId);
  const [kind] = useState(thisDeviceKind);
  const set = useCallback(<K extends keyof Look>(k: K, v: Look[K]): Promise<boolean> => save(LOOK_KEYS[k], lookValue(k, v)), [save]);
  return { kind, look: lookOfRows(rows), set, error };
}
