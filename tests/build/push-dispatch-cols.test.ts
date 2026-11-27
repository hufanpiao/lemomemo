// 代码审查 M1（B2 BE-2）：push-dispatch/store.ts 的 colsOf 每一列都要在 shared/db.types.ts 对应表的 Row 里——
// 原来 COMMON 里有 source，anniversaries 没有这一列，线上第 1 步读纪念日会整批报错。放在 tests/build（要读文件，tests/functions 的 tsconfig 没有 node 类型）。
// store.ts 顶上有 `import type … from 'npm:…'`：路径放在变量里动态加载（写法同 tests/functions/push-dispatch-store.test.ts）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const STORE_PATH = '../../supabase/functions/push-dispatch/store.ts';
const { colsOf } = (await import(/* @vite-ignore */ STORE_PATH)) as { colsOf: (t: string) => string };

describe('push-dispatch 读的列都在 db.types.ts 里（代码审查 M1）', () => {
  it('events、todos、anniversaries 三张表逐列核对；anniversaries 不读 source', () => {
    const types = readFileSync(join(import.meta.dirname, '..', '..', 'shared', 'db.types.ts'), 'utf8');
    const pub = types.slice(types.indexOf('"public": {'));
    for (const t of ['events', 'todos', 'anniversaries'] as const) {
      const at = pub.indexOf(`"${t}": {`);
      expect(at).toBeGreaterThan(-1);
      const row = /Row: \{\s*([^}]*)\}/.exec(pub.slice(at))?.[1] ?? '';
      const have = new Set([...row.matchAll(/"([a-z_0-9]+)":/g)].map((m) => m[1]));
      const want = colsOf(t).split(',').map((c) => c.trim());
      expect(want.length).toBeGreaterThan(5);
      expect(want.filter((c) => !have.has(c)), t).toEqual([]);
    }
    expect(colsOf('anniversaries').split(', ')).not.toContain('source');
  });
});
