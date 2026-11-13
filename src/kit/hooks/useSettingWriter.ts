// 一页一个 settings 写入器（REMIND-settings-core）：提醒、日历、随手记（R-413 点“不用”记 notes.merge_dismissed）共用这一份，原来各功能各写一遍。
// • 取本机 settings 集合；写经 core/setting-write.ts 的 createSettingWriter（排队、刚 insert 还没进本机集合的按记下的 id patch、update 按最新值算）
// • 写不进本机（切换账号中、本机库不能用）时 error 为 true
import { useCallback, useRef, useState } from 'react';
import { createSettingWriter, type SettingRow } from '../../core/setting-write.ts';
import { useCollection } from './useCollection.ts';

export function useSettingWriter(newId: () => string = () => crypto.randomUUID()) {
  const rows = useCollection<SettingRow>('settings');
  const [error, setError] = useState(false);
  // 最新的本机行和 newId（排队中的写读它们，不读闭包里旧的那份）
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const newIdRef = useRef(newId);
  newIdRef.current = newId;
  const [writer] = useState(() => createSettingWriter({ rows: () => rowsRef.current, newId: () => newIdRef.current(), onResult: (ok) => setError(!ok) }));
  const save = useCallback((key: string, value: unknown): Promise<void> => writer.save(key, value), [writer]);
  return { rows, writer, save, error };
}
