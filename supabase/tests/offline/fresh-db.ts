// 离线建库（PGlite + Supabase 桩 + 依次跑 supabase/migrations 下的迁移），一处写、两处用（B1 接手清单 C8）：
//   supabase/tests/offline/run.mjs（npm run test:db:offline，要 tap-shim）
//   tests/data-manifest/pglite-migrated.ts（Vitest 里要真库授权的测试，不要 tap-shim）
// 不代替 supabase db reset：桩不是 Supabase 的真实定义，pg_cron、pg_net 被跳过，真库差异见 B0 实测清单。只在 Node 下用（读文件）。
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PGlite } from '@electric-sql/pglite';

const OFFLINE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(resolve(OFFLINE, '../../..'), 'supabase/migrations');

/** 真库没有的扩展跳过（pg_cron、pg_net）；cron.schedule 由桩接住 */
export const stripExt = (sql: string): string => sql.replace(/^create extension if not exists (pg_cron|pg_net)[^;]*;/gim, '-- (离线跳过) $&');

/** 要跑的迁移文件名，按执行顺序。0001～0007 是四位编号；B1 起的新迁移是 14 位时间戳（架构：以后的改动新建带时间戳的文件），
 *  按文件名排序就是执行顺序。数目不写死，调用方要打印就用这里的长度。
 *  目录里有 .sql 但编号不合这两种命名的直接报错（列出文件名），不悄悄跳过——真库的 supabase db reset 不会跳过它。dir 只给测试用 */
export function migrationFiles(dir: string = MIGRATIONS): string[] {
  const sql = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  const bad = sql.filter((f) => !/^(\d{4}|\d{14})_.*\.sql$/.test(f));
  if (bad.length) throw new Error(`迁移目录里有不合命名（4 位编号或 14 位时间戳 + _名字.sql）的文件：${bad.join('、')}`);
  return sql.sort();
}

export interface FreshDbOptions {
  /** 跑迁移（默认 true） */
  migrations?: boolean;
  /** 装 pgTAP 的替身 tap-shim.psql（默认 false；run.mjs 跑 RLS 测试要） */
  tapShim?: boolean;
}

export async function freshDb({ migrations = true, tapShim = false }: FreshDbOptions = {}): Promise<PGlite> {
  // 动态 import：只 import 本模块类型的地方不必加载 WASM
  const { PGlite: Ctor } = await import('@electric-sql/pglite');
  const { vector } = await import('@electric-sql/pglite-pgvector');
  const db = new Ctor({ extensions: { vector } });
  await db.exec(readFileSync(join(OFFLINE, 'supabase-stub.psql'), 'utf8'));
  if (tapShim) await db.exec(readFileSync(join(OFFLINE, 'tap-shim.psql'), 'utf8'));
  await db.exec(`alter role postgres set search_path = "$user", public, extensions; set search_path = "$user", public, extensions;`);
  if (migrations) {
    for (const f of migrationFiles()) {
      try {
        await db.exec(stripExt(readFileSync(join(MIGRATIONS, f), 'utf8')));
      } catch (e) {
        throw new Error(`迁移 ${f} 失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
  return db;
}
