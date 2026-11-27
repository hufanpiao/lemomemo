// 账号导出带上长期记忆（R-495）：清单写 export: json 就进导出；只读本人没删的，不带判重列和检索词条。
import { describe, expect, it } from 'vitest';
import { allManifests } from '../../shared/manifests/index.ts';
import { exportTablesOf } from '../../supabase/functions/account/export.ts';
import { A, accountSetup as setup, B } from './account-fakes.ts';
import { runExport } from './account-export-harness.ts';

const TABLES = exportTablesOf(allManifests);
const mem = (i: number, user: string, text: string) => ({ id: `74000000-0000-4000-8000-${String(i).padStart(12, '0')}`, user_id: user, text, norm: text, grams: ['x'], deleted_at: null, source: 'chat', created_at: i, updated_at: i });

describe('账号导出：长期记忆', () => {
  it('清单挑表：从 private 读、只读没删的、去掉 norm grams deleted_at；private 里只有这一张', () => {
    const priv = TABLES.filter((t) => t.schema === 'private');
    expect(priv.map((t) => t.name)).toEqual(['ai_memories']);
    expect(priv[0]).toMatchObject({ liveOnly: true, keyCol: 'id', keyType: 'uuid', omitCols: ['norm', 'grams', 'deleted_at'] });
    expect(TABLES.find((t) => t.name === 'todos')).toMatchObject({ schema: 'public', liveOnly: false });
  });

  it('整份导出里有本人的记忆，没有别人的，也没有判重列', async () => {
    const { db, box } = setup();
    db.tables.set('ai_memories', [mem(1, A, '对花生过敏'), mem(2, B, '别人的记忆'), mem(3, A, '周报周五交')]);
    const run = await runExport(db, box, { exportTables: TABLES });
    const rows = (run.doc['tables'] as Record<string, Record<string, unknown>[]>)['ai_memories'] ?? [];
    expect(rows.map((m) => m['text'])).toEqual(['对花生过敏', '周报周五交']);
    for (const r of rows) for (const c of ['norm', 'grams', 'deleted_at']) expect(r).not.toHaveProperty(c);
  });
});
