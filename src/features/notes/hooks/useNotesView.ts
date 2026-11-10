// 随手记页读“随手记显示方式”（B4 S1；R-53、R-78；TC-B4-01）：按这台设备的类型读 notes.view@mobile 或 notes.view@desktop，
// 值 'masonry' | 'list'，没存、认不出都是瀑布流（默认）。写在设置功能里（settings 的 hooks/useNotesViewSetting.ts，键名同一个 NOTES_VIEW_KEY）
import { useState } from 'react';
import { settingValue, type SettingRow } from '../../../core/setting-read.ts';
import { perDeviceKey, thisDeviceKind } from '../../../platform/device-kind.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';

export type NotesView = 'masonry' | 'list';
export const NOTES_VIEW_KEY = 'notes.view';

export const viewOf = (v: unknown): NotesView => (v === 'list' ? 'list' : 'masonry');

export function useNotesViewValue(): NotesView {
  const rows = useCollection<SettingRow>('settings');
  const [kind] = useState(thisDeviceKind);
  return viewOf(settingValue(rows, perDeviceKey(NOTES_VIEW_KEY, kind)));
}
