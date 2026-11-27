// K8 的代码不进首屏（代码审查 newItem 重构 L1；冲突提示方案 2.1：gate 跟 after-paint 块，宿主单独分包）
// 11-05 从 first-paint-graph.test.ts 拆出（那个文件超过 300 行）；推依赖图的帮手在 first-paint-lib.ts
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENTRY, GRAPH_TIMEOUT_MS, reach, rel, ROOT, withPatch } from './first-paint-lib.ts';

describe('K8 的 core 代码不进首屏（代码审查 newItem 重构 L1）', { timeout: GRAPH_TIMEOUT_MS }, () => {
  const LAZY = ['src/core/outbox-new-item.ts', 'src/core/outbox-gone.ts', 'src/core/write-gone.ts'].map((f) => resolve(ROOT, f));
  it('main.tsx 和首屏名单里各块的静态闭包都到不了 outbox-new-item.ts、outbox-gone.ts、write-gone.ts（只经 import() 按需下载）', async () => {
    const { FIRST_PAINT_DYNAMIC } = (await import('../../build/check_first_paint_chunks.mjs')) as { FIRST_PAINT_DYNAMIC: string[] };
    for (const root of [ENTRY, ...FIRST_PAINT_DYNAMIC.map((k) => resolve(ROOT, 'src', k))]) {
      const { prev } = reach(root);
      expect(LAZY.filter((f) => prev.has(f)).map(rel), rel(root)).toEqual([]);
    }
  });

  it('拦得住变异：outbox.ts、outbox-logic.ts 改成静态引 newItem / resolveGoneImpl', () => {
    const cases: [string, string, string][] = [
      ['src/core/outbox.ts', "import { newItem } from './outbox-new-item.ts';\nvoid newItem;\n", 'src/core/outbox-new-item.ts'],
      ['src/core/outbox-logic.ts', "import { newItem as _n } from './outbox-new-item.ts';\nvoid _n;\n", 'src/core/outbox-new-item.ts'],
      ['src/core/outbox.ts', "import { resolveGoneImpl } from './outbox-gone.ts';\nvoid resolveGoneImpl;\n", 'src/core/outbox-gone.ts'],
      ['src/core/outbox-logic.ts', "import { resolveGoneImpl as _g } from './outbox-gone.ts';\nvoid _g;\n", 'src/core/outbox-gone.ts'],
    ];
    for (const [file, line, target] of cases) {
      const read = withPatch(file, (src) => line + src);
      expect(reach(ENTRY, read).prev.has(resolve(ROOT, target)), `${file} → ${target}`).toBe(true);
    }
  });
});

describe('K8 冲突提示的界面不进首屏（方案 2.1：gate 跟 after-paint 块，宿主单独分包）', { timeout: GRAPH_TIMEOUT_MS }, () => {
  const isUi = (f: string): boolean => {
    const r = rel(f);
    return r === 'src/app/sync-notice-gate.ts' || r === 'src/app/sync-notice-store.ts' || r.startsWith('src/features/sync-notice/');
  };
  it('main.tsx 和首屏名单里各块的静态闭包都到不了 sync-notice-gate.ts、sync-notice-store.ts、features/sync-notice/**', async () => {
    const { FIRST_PAINT_DYNAMIC } = (await import('../../build/check_first_paint_chunks.mjs')) as { FIRST_PAINT_DYNAMIC: string[] };
    for (const root of [ENTRY, ...FIRST_PAINT_DYNAMIC.map((k) => resolve(ROOT, 'src', k))]) {
      expect([...reach(root).prev.keys()].filter(isUi).map(rel), rel(root)).toEqual([]);
    }
  });

  it('gate 静态闭包里只有 sync-notice 的 index.ts、白名单和类型，没有宿主（ui/、hooks 的 React 部分、词典、字段描述）', () => {
    const got = [...reach(resolve(ROOT, 'src/app/sync-notice-gate.ts')).prev.keys()].map(rel).filter((r) => r.startsWith('src/features/sync-notice/'));
    expect(got.sort()).toEqual(['src/features/sync-notice/index.ts']);
  });

  it('拦得住变异：App.tsx 静态引 gate、main.tsx 静态引宿主', () => {
    const cases: [string, string][] = [
      ['src/app/App.tsx', "import { startSyncNotices as _s } from './sync-notice-gate.ts';\nvoid _s;\n"],
      ['src/app/main.tsx', "import _H from '../features/sync-notice/ui/SyncNoticeHost.tsx';\nvoid _H;\n"],
    ];
    for (const [file, line] of cases) {
      const read = withPatch(file, (src) => line + src);
      expect([...reach(ENTRY, read).prev.keys()].some(isUi), file).toBe(true);
    }
  });
});
