// 离线建一个跑完全部迁移的 PGlite：建库代码和 supabase/tests/offline/run.mjs 共用 supabase/tests/offline/fresh-db.ts（B1 接手清单 C8）。
// 给 Vitest 里要真库授权的测试用（grant-matrix.test.ts）；不代替 supabase db reset，真库差异见 B0 实测清单。
// 只在 Node 下用（读文件）。
import type { PGlite } from '@electric-sql/pglite';
import { freshDb } from '../../supabase/tests/offline/fresh-db.ts';

export function migratedPglite(): Promise<PGlite> {
  return freshDb();
}
