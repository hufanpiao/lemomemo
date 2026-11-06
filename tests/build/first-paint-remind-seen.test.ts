// “这一次响过”的本机记录（features/reminders/data/remind-seen.ts，REMIND-shown-persist）不进首屏、也不进“错过的提醒”的分包
// （方案 docs/03-评审/B2/B2-方案-提醒响过持久化.md 第 9 节第 8 条；代码审查一 M1）：
// 从首屏入口 src/app/main.tsx 和首屏路径上的每个懒加载入口（build/check_first_paint_chunks.mjs 的 FIRST_PAINT_DYNAMIC：今天页、告知页、
// MissedReminders 等）出发，只沿静态 import 走（first-paint-lib 的认法），都走不到 remind-seen.ts；
// 它只该由引擎（hooks/useReminders.ts，RemindHost 分包）静态引。下面直接模拟两个变异，确认拦得住
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIRST_PAINT_DYNAMIC } from '../../build/check_first_paint_chunks.mjs';
import { ENTRY, GRAPH_TIMEOUT_MS, reach, ROOT, show, withPatch, type Read } from './first-paint-lib.ts';

const SEEN = resolve(ROOT, 'src/features/reminders/data/remind-seen.ts');
const MISSED = resolve(ROOT, 'src/features/reminders/ui/MissedReminders.tsx');
const ENGINE = resolve(ROOT, 'src/features/reminders/hooks/useReminders.ts');
/** 首屏要下载的：入口 + 首屏路径上的懒加载入口 */
const FIRST = [ENTRY, ...FIRST_PAINT_DYNAMIC.map((f: string) => resolve(ROOT, 'src', f))];

/** 从 from 静态走到 remind-seen.ts 的路径；走不到是 null */
function pathToSeen(from: string, read?: Read): string | null {
  const { prev } = reach(from, read);
  if (!prev.has(SEEN)) return null;
  const path: string[] = [];
  for (let n: string | null | undefined = SEEN; n; n = prev.get(n)) path.unshift(show(n));
  return path.join(' → ');
}

describe('remind-seen 不进首屏、不进“错过的提醒”的分包（代码审查一 M1）', { timeout: GRAPH_TIMEOUT_MS }, () => {
  it('首屏入口、首屏的懒加载入口（含 MissedReminders）都走不到 remind-seen.ts；引擎走得到（图确实走起来了）', () => {
    expect(FIRST).toContain(MISSED);
    for (const f of FIRST) {
      expect(reach(f).missing, show(f)).toEqual([]);
      expect(pathToSeen(f), show(f)).toBeNull();
    }
    expect(pathToSeen(ENGINE)).toBe('src/features/reminders/hooks/useReminders.ts → src/features/reminders/data/remind-seen.ts');
  });

  it('变异：快照（remind-list.ts，MissedReminders 静态引它）静态引 remind-seen：首屏这一圈里 MissedReminders 拦住，路径经过 remind-list', () => {
    const read = withPatch('src/features/reminders/hooks/remind-list.ts', (s) => `import { rangView } from '../data/remind-seen.ts';\nvoid rangView;\n${s}`);
    const hit = FIRST.filter((f) => pathToSeen(f, read) !== null);
    expect(hit).toContain(MISSED);
    expect(pathToSeen(MISSED, read)).toContain('remind-list.ts → src/features/reminders/data/remind-seen.ts');
  });

  it('变异：MissedReminders 自己静态引 remind-seen：拦住', () => {
    const read = withPatch('src/features/reminders/ui/MissedReminders.tsx', (s) => `import { SEEN_KEY } from '../data/remind-seen.ts';\nvoid SEEN_KEY;\n${s}`);
    expect(pathToSeen(MISSED, read)).toBe('src/features/reminders/ui/MissedReminders.tsx → src/features/reminders/data/remind-seen.ts');
  });
});
