// 设置 › 随手记显示方式 的读写（B4 S1；R-53、R-78；TC-B4-01）：瀑布流 / 列表，按这台设备的类型存 notes.view@mobile 或 notes.view@desktop，只对本类设备生效
// • 键名、默认瀑布流和随手记页（notes 的 hooks/useNotesView.ts）一致；设备类型在 platform/env.ts（thisDeviceKind）
// • 写经 core/setting-write.ts 的 createSettingWriter（进 outbox、本机先生效，连点排队；同 calendar 的 useCalSettings）
import { useCallback, useRef, useState } from 'react';
import { createSettingWriter, settingValue, type SettingRow } from '../../../core/setting-write.ts';
import { perDeviceKey, thisDeviceKind, type DeviceKind } from '../../../platform/device-kind.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';

export type NotesView = 'masonry' | 'list';
/** 和随手记页 notes 的 NOTES_VIEW_KEY 同一个键（功能之间不互相 import 内部文件，两边各写一份，测试里对一次） */
const NOTES_VIEW_KEY = 'notes.view';
const viewOf = (v: unknown): NotesView => (v === 'list' ? 'list' : 'masonry');
const keyOf = (kind: DeviceKind): string => perDeviceKey(NOTES_VIEW_KEY, kind);

export function useNotesViewSetting(newId: () => string = () => crypto.randomUUID()) {
  const rows = useCollection<SettingRow>('settings');
  const [kind] = useState(thisDeviceKind);
  const [error, setError] = useState(false);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const newIdRef = useRef(newId);
  newIdRef.current = newId;
  const [writer] = useState(() => createSettingWriter({ rows: () => rowsRef.current, newId: () => newIdRef.current(), onResult: (ok) => setError(!ok) }));
  const set = useCallback((v: NotesView): Promise<void> => writer.save(keyOf(kind), v), [writer, kind]);
  return { kind, view: viewOf(settingValue(rows, keyOf(kind))), set, error };
}
