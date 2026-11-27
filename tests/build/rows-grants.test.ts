// shared/schema/rows.ts 和迁移里的列级授权、数据清单三处一致（B0 集成；架构 3.5“清单、grant、apply_patch、rows.ts 四处一致”的 rows.ts 那一段）
// 只读迁移文本，不连数据库：取 `grant insert (…) on public.<表> to authenticated;` 和 `grant update (…)`
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allManifests } from '../../shared/manifests/index.ts';
import { insertSchema, patchSchema, rowsWrite, WRITE_RULES, type WritableTable } from '../../shared/schema/rows.ts';

const root = join(import.meta.dirname, '..', '..');
const migDir = join(root, 'supabase', 'migrations');
const sql = readdirSync(migDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(migDir, f), 'utf8').replace(/--[^\n]*/g, ''))
  .join('\n');

/** 某张表给 authenticated 的 insert / update 列（迁移里可能分几句写，合起来） */
function granted(table: string, priv: 'insert' | 'update'): string[] {
  const re = new RegExp(`grant\\s+${priv}\\s*\\(([^)]*)\\)\\s+on\\s+public\\.${table}\\s+to\\s+authenticated\\s*;`, 'gi');
  const cols = [...sql.matchAll(re)].flatMap((m) => (m[1] ?? '').split(',').map((c) => c.trim()).filter(Boolean));
  return [...new Set(cols)].sort();
}

const sorted = (a: Iterable<string>) => [...new Set(a)].sort();
const tables = Object.keys(rowsWrite) as WritableTable[];

describe('rows.ts 和列级授权一致', () => {
  for (const t of tables) {
    it(`${t}：insert 的列 = grant insert`, () => {
      if (!WRITE_RULES[t].insert) {
        expect(granted(t, 'insert')).toEqual([]);
        return;
      }
      expect(sorted(Object.keys(insertSchema(t).shape))).toEqual(granted(t, 'insert'));
    });

    it(`${t}：patch 的列 = grant update`, () => {
      expect(sorted(Object.keys(patchSchema(t).shape))).toEqual(granted(t, 'update'));
    });

    it(`${t}：和数据清单的 clientWritable、insertOnly、updateOnly 一致`, () => {
      const m = allManifests.flatMap((x) => x.tables).find((x) => x.schema === 'public' && x.name === t);
      expect(m, `清单里没有 public.${t}`).toBeDefined();
      if (!m) return;
      expect(sorted(Object.keys(rowsWrite[t].shape))).toEqual(sorted(m.clientWritable));
      expect(sorted(WRITE_RULES[t].insertOnly)).toEqual(sorted(m.insertOnly));
      expect(sorted(WRITE_RULES[t].updateOnly)).toEqual(sorted(m.updateOnly));
    });
  }

  it('自测：解析得到 devices.platform 只在 insert 里', () => {
    expect(granted('devices', 'insert')).toContain('platform');
    expect(granted('devices', 'update')).not.toContain('platform');
  });
});
