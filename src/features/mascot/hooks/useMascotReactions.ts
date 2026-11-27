// 吉祥物的反应：
// • 待办勾完、新增、删除：看本机集合前后的差别（一次变太多的是同步或批量，不反应）
// • 提醒在响（kit 提醒队列露出来的那一条）：mail 状态，处理掉就解除
// • 久不操作（SLEEP_MS 没有按下、按键、滚轮）：sleep 状态，再碰一下就醒
// 后两种只有带表情环的角色（目录的 moods）有表情，其余角色舞台不理
import { useEffect, useRef } from 'react';
import { useRemindQueue, visibleEntry } from '../../../kit/state/remind-queue.ts';
import { useCollection } from '../../../kit/hooks/useCollection.ts';
import type { MoodFlag, ReactKind } from './stage.ts';

interface Row {
  id: string;
  done?: unknown;
  deleted_at?: unknown;
  undone?: unknown;
}

const SETTLE_MS = 1200;
const MAX_CHANGES = 3;
export const SLEEP_MS = 60_000;

const snapshot = (rows: readonly Row[]): Map<string, boolean> =>
  new Map(rows.filter((r) => r.deleted_at == null && r.undone !== true).map((r) => [r.id, r.done === true]));

export function kindOfChange(prev: ReadonlyMap<string, boolean>, rows: readonly Row[]): Exclude<ReactKind, 'tap'> | null {
  const now = snapshot(rows);
  let done = 0;
  let add = 0;
  let del = 0;
  for (const [id, d] of now) {
    const was = prev.get(id);
    if (was === undefined) add += 1;
    else if (d && !was) done += 1;
  }
  for (const id of prev.keys()) if (!now.has(id)) del += 1;
  const n = done + add + del;
  if (n === 0 || n > MAX_CHANGES) return null;
  return done > 0 ? 'done' : del > 0 ? 'del' : 'add';
}

export function useMascotReactions(fire: (k: ReactKind) => void, flag: (f: MoodFlag, on: boolean) => void): void {
  const rows = useCollection<Row>('todos');
  const prev = useRef<Map<string, boolean> | null>(null);
  const t0 = useRef(performance.now());
  useEffect(() => {
    const p = prev.current;
    if (p && performance.now() - t0.current > SETTLE_MS) {
      const k = kindOfChange(p, rows);
      if (k) fire(k);
    }
    prev.current = snapshot(rows);
  }, [rows, fire]);

  const ringing = useRemindQueue((s) => visibleEntry(s)?.tag ?? null);
  useEffect(() => flag('mail', ringing !== null), [ringing, flag]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => flag('sleep', true), SLEEP_MS);
    };
    const poke = (): void => {
      flag('sleep', false);
      arm();
    };
    const opt = { capture: true, passive: true } as const;
    const evs = ['pointerdown', 'keydown', 'wheel'] as const;
    for (const e of evs) document.addEventListener(e, poke, opt);
    // 回到今天页（接回留着的舞台）也算醒着
    poke();
    return () => {
      clearTimeout(timer);
      for (const e of evs) document.removeEventListener(e, poke, opt);
    };
  }, [flag]);
}
