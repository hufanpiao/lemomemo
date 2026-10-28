// 临时生成 shared/db.types.ts：没有 Docker 跑不了 supabase gen types，先从 PGlite 上的迁移结果按同样的形状生成
// 有 Docker 后改用：npx supabase gen types typescript --local --schema public,private > shared/db.types.ts，删掉本脚本
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const db = new PGlite({ extensions: { vector } });
await db.exec(readFileSync(join(here, 'supabase-stub.sql'), 'utf8'));
for (const f of readdirSync(join(root, 'supabase/migrations')).sort()) {
  await db.exec(readFileSync(join(root, 'supabase/migrations', f), 'utf8').replace(/^create extension if not exists (pg_cron|pg_net)[^;]*;/gim, ''));
}

const scalar = (udt) => ({
  uuid: 'string', text: 'string', date: 'string', timestamptz: 'string', bytea: 'string', halfvec: 'string',
  int2: 'number', int4: 'number', int8: 'number', bool: 'boolean', jsonb: 'Json',
})[udt] ?? 'unknown';
const tsType = (c) => c.data_type === 'ARRAY' ? `${scalar(c.udt_name.slice(1))}[]` : scalar(c.udt_name);

const cols = (await db.query(`select table_schema, table_name, column_name, data_type, udt_name, is_nullable, column_default, is_identity
  from information_schema.columns where table_schema in ('public', 'private') order by table_schema, table_name, ordinal_position`)).rows;
const rels = (await db.query(`select n.nspname as s, c.relname as t, c.relkind as k from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('public', 'private') and c.relkind in ('r', 'v') order by 1, 2`)).rows;
const fns = (await db.query(`select p.proname as f, pg_get_function_arguments(p.oid) as args, format_type(p.prorettype, null) as ret
  from pg_proc p where p.pronamespace = 'public'::regnamespace order by 1`)).rows;

const out = [];
out.push('// 【临时】数据库类型：由 supabase/tests/offline/gen-db-types.mjs 从 7 个迁移生成（没有 Docker，跑不了 supabase gen types）');
out.push('// 待 Docker：npx supabase gen types typescript --local --schema public,private > shared/db.types.ts 替换本文件（形状相同，调用方不用改）');
out.push('// 不要手改：改迁移以后重新生成');
out.push('');
out.push('export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];');
out.push('');
out.push('export type Database = {');
for (const s of ['public', 'private']) {
  out.push(`  ${s}: {`);
  for (const kind of [['Tables', 'r'], ['Views', 'v']]) {
    out.push(`    ${kind[0]}: {`);
    const list = rels.filter((r) => r.s === s && r.k === kind[1]);
    // 空的一节写成 supabase gen types 的样子（{ [_ in never]: never }），不写 {}（ESLint no-empty-object-type，B0 集成）
    if (list.length === 0) out.push('      [_ in never]: never;');
    for (const r of list) {
      const cs = cols.filter((c) => c.table_schema === s && c.table_name === r.t);
      out.push(`      ${r.t}: {`);
      out.push(`        Row: { ${cs.map((c) => `${c.column_name}: ${tsType(c)}${c.is_nullable === 'YES' ? ' | null' : ''}`).join('; ')} };`);
      if (kind[1] === 'r') {
        const opt = (c) => c.is_nullable === 'YES' || c.column_default !== null || c.is_identity === 'YES';
        out.push(`        Insert: { ${cs.map((c) => `${c.column_name}${opt(c) ? '?' : ''}: ${tsType(c)}${c.is_nullable === 'YES' ? ' | null' : ''}`).join('; ')} };`);
        out.push(`        Update: { ${cs.map((c) => `${c.column_name}?: ${tsType(c)}${c.is_nullable === 'YES' ? ' | null' : ''}`).join('; ')} };`);
      }
      // supabase-js 的 GenericTable / GenericView 要有 Relationships（和 supabase gen types 一样；外键关系离线不生成）
      out.push('        Relationships: [];');
      out.push('      };');
    }
    out.push('    };');
  }
  out.push('    Functions: {');
  const pgTs = { text: 'string', uuid: 'string', jsonb: 'Json', boolean: 'boolean', integer: 'number', void: 'undefined' };
  const fnList = s === 'public' ? fns : [];
  if (fnList.length === 0) out.push('      [_ in never]: never;');
  for (const f of fnList) {
    const args = f.args.split(',').map((a) => a.trim()).filter(Boolean).map((a) => {
      const m = /^(\w+) (\w+)( DEFAULT .*)?$/.exec(a);
      return m ? `${m[1]}${m[3] ? '?' : ''}: ${pgTs[m[2]] ?? 'unknown'}` : '';
    }).join('; ');
    out.push(`      ${f.f}: { Args: { ${args} }; Returns: ${pgTs[f.ret] ?? 'unknown'} };`);
  }
  out.push('    };');
  out.push('    Enums: {');
  out.push('      [_ in never]: never;');
  out.push('    };');
  out.push('    CompositeTypes: {');
  out.push('      [_ in never]: never;');
  out.push('    };');
  out.push('  };');
}
out.push('};');
out.push('');
out.push("export type Tables<S extends keyof Database, T extends keyof Database[S]['Tables']> = Database[S]['Tables'][T] extends { Row: infer R } ? R : never;");
out.push("export type TablesInsert<S extends keyof Database, T extends keyof Database[S]['Tables']> = Database[S]['Tables'][T] extends { Insert: infer R } ? R : never;");
out.push("export type TablesUpdate<S extends keyof Database, T extends keyof Database[S]['Tables']> = Database[S]['Tables'][T] extends { Update: infer R } ? R : never;");
out.push('');
writeFileSync(join(root, 'shared/db.types.ts'), out.join('\n'));
await db.close();
console.log('已生成 shared/db.types.ts');
