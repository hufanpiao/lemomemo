// supabase/tests/offline/fresh-db.ts 的迁移文件名单：命名不合的 .sql 直接报错，不悄悄跳过（代码审查复审低级）
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { migrationFiles } from '../../supabase/tests/offline/fresh-db.ts';

describe('migrationFiles：迁移文件名单', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const make = (names: string[]) => {
    dir = mkdtempSync(join(tmpdir(), 'lemo-mig-'));
    for (const n of names) writeFileSync(join(dir, n), '');
    return dir;
  };

  it('4 位编号和 14 位时间戳都认，按文件名排序；非 .sql 不管', () => {
    expect(migrationFiles(make(['20261029100000_b.sql', '0002_x.sql', '0001_a.sql', 'README.md']))).toEqual(['0001_a.sql', '0002_x.sql', '20261029100000_b.sql']);
  });

  it('有命名不合的 .sql 直接报错，并列出文件名', () => {
    expect(() => migrationFiles(make(['0001_a.sql', '12_short.sql', 'core.sql']))).toThrow(/12_short\.sql、core\.sql/);
  });

  it('仓库里的迁移目录本身合规', () => {
    expect(migrationFiles().length).toBeGreaterThan(0);
  });
});
