// TC-B1-47（架构 4.1、0.27 第 1 点）：本机库的 store 结构（store、keyPath、indexes）变了而 DB_VERSION 没加 1、或锁文件没更新，CI 失败
// 真仓库按 src/core/cache-schema.lock 核一遍；tests/arch-fixtures/cache-schema/ 的每个样例在真结构上改一处，证明拦得住
// 样例格式：{lock: "repo", db_version: "repo" | "repo+1", patch?: {仓名: 要覆盖的字段}, add?: [新仓], expect: 错误码 | null}
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DB_VERSION } from '../../src/core/cache-migrations.ts';
import { cacheStores, checkSchemaLock, type SchemaLock, type StoreDef } from '../../src/core/cache-schema.ts';
import { FIXTURES, ROOT } from './fixture-header.ts';

interface Sample {
  lock: 'repo';
  db_version: 'repo' | 'repo+1';
  patch?: Record<string, Partial<StoreDef>>;
  add?: StoreDef[];
  expect: string | null;
}

const lock = JSON.parse(readFileSync(join(ROOT, 'src', 'core', 'cache-schema.lock'), 'utf8')) as SchemaLock;
const dir = join(FIXTURES, 'cache-schema');
const samples = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ file: f, s: JSON.parse(readFileSync(join(dir, f), 'utf8')) as Sample }));

describe('cache-schema.lock（TC-B1-47）', () => {
  it('真仓库：结构和锁文件、DB_VERSION 一致', () => {
    expect(checkSchemaLock(cacheStores(), DB_VERSION, lock)).toBeNull();
  });

  it('样例目录里至少有一个违规样例和一个对照组', () => {
    expect(samples.some((x) => x.s.expect !== null)).toBe(true);
    expect(samples.some((x) => x.s.expect === null)).toBe(true);
  });

  for (const { file, s } of samples) {
    it(`样例 ${file}：${s.expect ?? '应通过'}`, () => {
      const stores = cacheStores()
        .map((st) => ({ ...st, ...(s.patch?.[st.name] ?? {}) }))
        .concat(s.add ?? []);
      const v = s.db_version === 'repo+1' ? lock.db_version + 1 : lock.db_version;
      expect(checkSchemaLock(stores, v, lock)).toBe(s.expect);
    });
  }
});
