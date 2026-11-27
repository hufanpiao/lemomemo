// 本机拉备份的两条 Windows 凭据只有一套名字（B7a 遗留第 1 条）：原来 set-r2-tokens.ps1 -Kind pull 把 R2 只读令牌写成两条
// lemomemo/R2_PULL_ACCESS_KEY_ID、lemomemo/R2_PULL_SECRET_ACCESS_KEY，pull.ps1 却只读一条 lemomemo.backup.r2-pull，
// 照 B0 清单和环境清单做完，pull.ps1 照样报“凭据管理器里没有 lemomemo.backup.r2-pull”。
// 现在统一成：BACKUP_PULL_TOKEN → lemomemo.backup.pull；R2 只读令牌 → 一条 lemomemo.backup.r2-pull（用户名栏 Access Key ID、密码栏 Secret Access Key）。
// 这里对仓库里的源码、文档、脚本逐个 grep（fs 遍历仓库的源目录和根目录文件，不起子进程，不进 node-slow）：旧名字一处都不许有，
// lemomemo.backup.* 只许是这两个；写的、读的都用同一个名字（读写都经 tools/keys/cred.ps1，B7a 复审“重复和简化”）。
// 评审记录（docs/03-评审）和历史版本（*/历史版本/*）是当时的原文，不改，不在核对范围里；node_modules、dist、构建产物、.e2e-sb（本机 e2e 的副本）不看。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SELF = 'tests/build/backup-cred-names.test.ts';
const PULL = 'lemomemo.backup.pull';
const R2 = 'lemomemo.backup.r2-pull';
const TEXT = /\.(ps1|psm1|mjs|cjs|js|ts|tsx|md|json|ya?ml|toml|sh|py|sql|txt)$/;

const SRC_DIRS = ['src', 'tests', 'docs', 'supabase', 'tools', 'shared', 'build', 'site', 'desktop', 'workers', 'functions', '.github', '.githooks', 'data'];
const SKIP = new Set(['node_modules', 'dist', 'target', 'gen', '历史版本', '.git', '.e2e-sb']);
function walk(rel: string, out: string[]): void {
  for (const e of readdirSync(join(ROOT, rel), { withFileTypes: true })) {
    const f = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (!SKIP.has(e.name) && f !== 'docs/03-评审') walk(f, out);
    } else if (TEXT.test(e.name) && f !== SELF) out.push(f);
  }
}
const files: string[] = readdirSync(ROOT, { withFileTypes: true }).filter((e) => e.isFile() && TEXT.test(e.name)).map((e) => e.name);
for (const d of SRC_DIRS) walk(d, files);
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
const hits = (re: RegExp) => files.flatMap((f) => [...read(f).matchAll(re)].map((m) => `${f}: ${m[0]}`));

describe('本机拉备份的凭据名全仓库只有一套', () => {
  it('能读到仓库里的文件（遍历不是空的）', () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('tools/backup/pull.ps1');
  });

  it('旧名字 lemomemo/R2_PULL_* 一处都没有', () => {
    expect(hits(/lemomemo\/R2_PULL[A-Z_]*/g)).toEqual([]);
  });

  it('lemomemo.backup.* 只出现 lemomemo.backup.pull 和 lemomemo.backup.r2-pull 两个名字', () => {
    const names = new Set(hits(/lemomemo\.backup\.[A-Za-z0-9_.-]*[A-Za-z0-9_-]/g).map((h) => h.slice(h.lastIndexOf(': ') + 2)));
    expect([...names].sort()).toEqual([PULL, R2]);
  });

  it('R2 只读令牌：写的两处（pull.ps1 -Setup、set-r2-tokens.ps1 -Kind pull）和读的一处（pull.ps1）都是一条 lemomemo.backup.r2-pull；BACKUP_PULL_TOKEN 由 set-backup-pull-token.ps1 写、pull.ps1 读', () => {
    const pull = read('tools/backup/pull.ps1');
    const keys = read('tools/keys/set-r2-tokens.ps1');
    const token = read('tools/keys/set-backup-pull-token.ps1');
    expect(pull).toContain(`Write-LemoCred '${R2}' $id $sk`);
    expect(pull).toContain(`Get-Cred '${R2}' `);
    expect(pull).not.toContain(`Write-LemoCred '${PULL}'`);   // B7a 复审第 8 条：-Setup 不再粘贴 BACKUP_PULL_TOKEN
    expect(pull).toContain(`Get-Cred '${PULL}' `);
    expect(token).toContain(`$CredTarget = '${PULL}'`);
    expect(token).toContain('Write-LemoCred $CredTarget ');
    expect(keys).toContain(`Write-LemoCred '${R2}' $id $sk`);
    expect((keys.match(/Write-LemoCred '/g) ?? []).length).toBe(1);
    // 凭据管理器的 C# 封装全仓库只有 tools/keys/cred.ps1 一份（B7a 复审“重复和简化”）
    expect(files.filter((f) => f.endsWith('.ps1') && /extern bool Cred(Write|Read)W/.test(read(f)))).toEqual(['tools/keys/cred.ps1']);
  });

  it('凭据说明（环境清单、B0 清单、正式发布说明）写的就是这两个名字', () => {
    expect(read('docs/08-发布/环境清单-v4.md')).toContain(`\`${R2}\``);
    expect(read('docs/08-发布/环境清单-v4.md')).toContain(`\`${PULL}\``);
    expect(read('docs/00-团队/负责人B0网页操作清单.md')).toContain(`\`${R2}\``);
    expect(read('docs/08-发布/正式发布说明-publish.md')).toContain(`\`${PULL}\`、\`${R2}\``);
  });
});
