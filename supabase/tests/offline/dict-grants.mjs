// 数据字典人工核对的辅助：从数据字典第 4 节抽出每张 public 表的列和“谁写”，列出 PGlite 上 authenticated 的实际列级授权（I/U），供人逐行看
// 用法：cd supabase/tests/offline && node dict-grants.mjs（只打印，不判断对错；结论见 docs/03-评审/B0/后端-数据字典人工核对.md）
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const off = dirname(fileURLToPath(import.meta.url));
const root = resolve(off, '../../..');

const dd = readFileSync(join(root, 'docs/05-数据字典/数据字典-v4.md'), 'utf8');
const sec4 = dd.slice(dd.indexOf('## 4. public 表逐张说明'), dd.indexOf('## 5. private'));
const tables = {};
let cur = null;
for (const line of sec4.split('\n')) {
  const h = /^### 4\.\w+ (\w+)/.exec(line);
  if (h) { cur = h[1]; tables[cur] = []; continue; }
  if (!cur || !line.startsWith('| ') || line.startsWith('| 列') || line.startsWith('|---')) continue;
  const cells = line.split('|').slice(1, -1).map((s) => s.trim());
  if (cells.length < 6) continue;
  tables[cur].push({ col: cells[0].replace(/\*|`/g, ''), who: cells[cells.length - 1] });
}
const db = new PGlite({ extensions: { vector } });
await db.exec(readFileSync(join(off, 'supabase-stub.sql'), 'utf8'));
await db.exec(`set search_path = "$user", public, extensions;`);
for (const f of readdirSync(join(root, 'supabase/migrations')).sort())
  await db.exec(readFileSync(join(root, 'supabase/migrations', f), 'utf8').replace(/^create extension if not exists (pg_cron|pg_net)[^;]*;/gim, ''));
const rows = (await db.query(`select table_name t, column_name c, privilege_type p from information_schema.column_privileges
  where grantee='authenticated' and table_schema='public' and privilege_type in ('INSERT','UPDATE')`)).rows;
const g = {};
for (const r of rows) ((g[r.t] ??= {})[r.c] ??= new Set()).add(r.p);
const COMMON = ['settings', 'devices', 'events', 'todos', 'categories', 'notes', 'note_images', 'note_files', 'anniversaries'];
for (const [t, cols] of Object.entries(tables)) {
  const out = [];
  const all = [...cols];
  if (COMMON.includes(t)) for (const c of ['id', 'deleted_at', 'undone', 'legacy_id', 'rev', 'fv', 'synced_at', 'user_id']) if (!all.some((x) => x.col === c)) all.push({ col: c, who: '(公共列)' });
  for (const { col, who } of all) {
    if (col.startsWith('＜')) continue;
    const p = g[t]?.[col] ?? new Set();
    const tag = `${p.has('INSERT') ? 'I' : '-'}${p.has('UPDATE') ? 'U' : '-'}`;
    out.push(`${col}\t${tag}\t${who.slice(0, 90)}`);
  }
  for (const c of Object.keys(g[t] ?? {})) if (!all.some((x) => x.col === c)) out.push(`${c}\t(授权有、字典没列)`);
  console.log(`\n## ${t}\n` + out.join('\n'));
}
await db.close();
