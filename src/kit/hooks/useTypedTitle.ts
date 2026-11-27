// 新建页接住带过来的东西（kit/state/new-item.ts 的一份）：新建（id 为 'new'）的表单挂上以后取走，交给 apply 一次改完（分两次改，第二次会拿着旧表单把第一次的盖掉）：
// • title：打字条“展开编辑”带过来的字（已经打的字不丢），当成用户打的填进标题；
// • row：AI 助手确认卡片“改一下”带过来的整条识别结果，按“记下来”同一个映射（shared/logic/capture-map.ts 的 captureRow）拼成一行，
//   各新建页用自己的 formOf 换成表单字段（时刻、时长、重要、提醒、项目、备注一样不丢，和直接“记下来”存进去的一致）
// 只取一次：StrictMode 下 effect 跑两遍也只填一次；取走就清，下次新建不沿用
import { useEffect, useRef } from 'react';
import { todayOf } from '../../../shared/core/date.ts';
import { captureRow, type CaptureItem } from '../../../shared/logic/capture-map.ts';
import { currentTz } from '../../core/current-tz.ts';
import { clock } from '../../platform/clock.ts';
import { takeNewItem } from '../state/new-item.ts';

/** 带过来的整条 → 和“记下来”同一个映射拼成的一行（id、批次留空：新建页自己有）；随手记、纪念日不在这两个新建页，回 null */
export function rowOfItem(item: CaptureItem, now = clock.now(), tz = currentTz()): Readonly<Record<string, unknown>> | null {
  const r = captureRow(item, { id: '', batchId: '', now, today: todayOf(now, tz), tz, source: 'page', rawText: '', origin: 'rule' });
  return r && (r.table === 'events' || r.table === 'todos') ? { ...r.row } : null;
}

export function useTypedTitle(id: string, apply: (p: { title?: string; row?: Readonly<Record<string, unknown>> }) => void): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || id !== 'new') return;
    done.current = true;
    const { title: t, item } = takeNewItem();
    const title = t !== null && t.trim() !== '' ? t : null;
    const row = item ? rowOfItem(item) : null;
    if (title === null && row === null) return;
    apply({ ...(title !== null ? { title } : {}), ...(row !== null ? { row } : {}) });
  }, [id, apply]);
}
