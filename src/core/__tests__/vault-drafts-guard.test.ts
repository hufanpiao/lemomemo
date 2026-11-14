// vault_drafts 仓的守卫（审查第 12 条）：这个仓留着，但目前禁止写入
// • 为什么留：架构 0.23 / R-123 定了隐私记页面“＋”的原话加密后存本机，用的就是这个仓（AAD 见数据字典）；
//   删掉要升 DB_VERSION，那个功能上线时还得再升一次、再写一次迁移，两次都碰不可重建的本机仓
// • 为什么禁写：功能还没做，现在谁往里写都没有加密约定，退出前计数（localUnsentCount）还会把它算成“没上传的”
// • 守卫：src、shared 的源码里只准下面几个文件提到它，各自只准按现在的用法用；要开放写入，先改这里的白名单和架构说明
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const ALLOWED: Record<string, string> = {
  'src/core/cache-schema.ts': '定义仓名和仓结构',
  'src/core/cache.ts': '关库前（beforeClose）放行草稿仓的集合',
  'src/core/boot.ts': '退出前只读计数',
  'src/core/cache-migrations.ts': '注释：迁移不动不可重建的仓',
  'src/features/settings/data/local.ts': '注释：计数口径',
};

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__' && e.name !== 'node_modules') out.push(...sources(p));
    } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const rel = (p: string): string => relative(ROOT, p).split(sep).join('/');
const read = (f: string): string => readFileSync(join(ROOT, f), 'utf8');
/** 用到 VAULT_DRAFTS 常量的代码行（去掉 import 行和注释行） */
const uses = (f: string): string[] =>
  read(f)
    .split(/\r?\n/)
    .filter((l) => /\bVAULT_DRAFTS\b/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l) && !/^import /.test(l));

describe('vault_drafts 禁止写入（审查第 12 条）', () => {
  it('源码里提到 vault_drafts / VAULT_DRAFTS 的只有白名单里的文件', () => {
    const hits = [...sources(join(ROOT, 'src')), ...sources(join(ROOT, 'shared'))]
      .filter((p) => /vault_drafts|VAULT_DRAFTS/.test(readFileSync(p, 'utf8')))
      .map(rel);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.filter((f) => !(f in ALLOWED))).toEqual([]);
  });

  it('白名单里各文件只按现在的用法用：cache.ts 只放进草稿仓集合，boot.ts 只在 readonly 事务里计数，其余只在注释里', () => {
    expect(uses('src/core/cache.ts')).toEqual(['  const draftStores = new Set([DRAFTS, VAULT_DRAFTS]);']);
    expect(uses('src/core/boot.ts')).toEqual(['    const stores = [OUTBOX, DRAFTS, VAULT_DRAFTS, PENDING_ACTIONS];']);
    expect(read('src/core/boot.ts')).toMatch(/const stores = \[OUTBOX, DRAFTS, VAULT_DRAFTS, PENDING_ACTIONS\];\r?\n\s*return await cache\.tx\(stores, 'readonly'/);
    for (const f of ['src/core/cache-migrations.ts', 'src/features/settings/data/local.ts']) expect(uses(f)).toEqual([]);
    // 字符串字面量 'vault_drafts' 只在 cache-schema.ts 定义处出现（别处不许绕开常量直接写仓名）
    for (const f of Object.keys(ALLOWED)) {
      if (f === 'src/core/cache-schema.ts') continue;
      expect(read(f)).not.toMatch(/['"`]vault_drafts['"`]/);
    }
  });
});
