// 导出大小预检（迁移 20261031100000 的 private.export_size_over）的表清单和数据清单一致（架构 0.47 第 19 条 Q3：清单写死在函数里，
// 和 account 的 exportTablesOf 同源比对），以及各片 gzip 首尾相接后用 Node zlib 能整份解开（0.47 续 ①“客户端”，⑤ 验收的工具之一）。
// 放在 tests/build（Node 环境）：要读迁移文件、用 node:zlib；account 函数自己的单测在 tests/functions/account-export*.test.ts（Workers 类型）。
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { allManifests } from '../../shared/manifests/index.ts';
import { exportTablesOf } from '../../supabase/functions/account/export.ts';

const TABLES = exportTablesOf(allManifests);
const sql = readFileSync(new URL('../../supabase/migrations/20261031100000_core_export_jobs.sql', import.meta.url), 'utf8');
const body = sql.slice(sql.indexOf('create function private.export_size_over'));

describe('export_size_over 的表清单（Q3）', () => {
  it('表名和顺序和 exportTablesOf(allManifests) 一样', () => {
    const m = /foreach tn in array array\[([^\]]+)\]/.exec(body);
    const list = [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect(list).toEqual(TABLES.map((t) => t.name));
  });

  it('没解锁时排除隐私记行的条件和各表 vaultRows.flag 一样（列名写法 → is not true；col = \'v\' 写法 → is distinct from）', () => {
    const conds = Object.fromEntries([...body.matchAll(/when tn = '([a-z_]+)' then ' and x\.(.+?)'$/gm)].map((x) => [x[1], x[2]]));
    const want = Object.fromEntries(TABLES.filter((t) => t.vaultRows).map((t) => {
      const flag = t.vaultRows?.flag ?? '';
      const m = /^([a-z_]+) = '([^']+)'$/.exec(flag);
      return [t.name, m ? `${m[1]} is distinct from ''${m[2]}''` : `${flag} is not true`];
    }));
    expect(conds).toEqual(want);
  });

  it('不写函数上的 set statement_timeout（Q2：不会给正在跑的语句重新计时），超时在循环里自己比时钟', () => {
    expect(body).not.toMatch(/set\s+statement_timeout/i);
    expect(body).toMatch(/clock_timestamp\(\) - t0 >= budget/);
  });
});

describe('多成员 gzip（0.47 续 ①：客户端把各片首尾相接）', () => {
  it('CompressionStream 压出的几个成员首尾相接，Node zlib 整份解开 = 各段原文拼起来', async () => {
    const parts = ['{"format":"lemomemo-export","tables":{"a":[1,', '2,3],"b":[', '"x"]}}'];
    const gz = await Promise.all(parts.map(async (p) => new Uint8Array(await new Response(new Blob([p]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer())));
    const all = Buffer.concat(gz);
    expect(JSON.parse(gunzipSync(all).toString('utf8'))).toEqual({ format: 'lemomemo-export', tables: { a: [1, 2, 3], b: ['x'] } });
  });
});
