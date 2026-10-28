// 离线建一个跑完 7 个迁移的 PGlite（和 supabase/tests/offline/run.mjs 的 freshDb 同一做法：Supabase 桩 → 迁移，跳过 pg_cron、pg_net）。
// 给 Vitest 里要真库授权的测试用（grant-matrix.test.ts）；不代替 supabase db reset，真库差异见 B0 实测清单。
// 只在 Node 下用（读文件）。
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const OFFLINE = join(ROOT, 'supabase/tests/offline');
const MIGRATIONS = join(ROOT, 'supabase/migrations');

const stripExt = (sql: string) => sql.replace(/^create extension if not exists (pg_cron|pg_net)[^;]*;/gim, '-- (离线跳过) $&');

export async function migratedPglite(): Promise<PGlite> {
  const { PGlite: Ctor } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const db = new Ctor({ extensions: { vector } });
  await db.exec(readFileSync(join(OFFLINE, 'supabase-stub.psql'), 'utf8'));
  await db.exec(`alter role postgres set search_path = "$user", public, extensions; set search_path = "$user", public, extensions;`);
  for (const f of readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()) {
    try {
      await db.exec(stripExt(readFileSync(join(MIGRATIONS, f), 'utf8')));
    } catch (e) {
      throw new Error(`迁移 ${f} 失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return db;
}
