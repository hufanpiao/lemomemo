#!/usr/bin/env node
// exe 流水线的两道检查（安全审查外壳 X-3、X-4），由运维接进 desktop.yml（F9）：
//   node desktop/src-tauri/scripts/ci-guard.mjs workflows     —— 编译前：.github/workflows 里一出现 --skip-env-check 就失败
//   node desktop/src-tauri/scripts/ci-guard.mjs permissions   —— 编译后：tauri-build 重新生成的权限文件和提交的不一致就失败
// （等于 git diff --exit-code，另外把没提交的新文件也算作不一致）
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKIP_ENV_CHECK } from './stage-web.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const PERMISSIONS = 'desktop/src-tauri/permissions';

/** 哪些流水线文件里出现了 --skip-env-check：files 是 [文件名, 内容] */
export function filesWithSkipFlag(files) {
  return files.filter(([, text]) => text.includes(SKIP_ENV_CHECK)).map(([name]) => name);
}

/** git status --porcelain 的输出里有没有改动（含未跟踪的新文件） */
export function dirtyLines(porcelain) {
  return porcelain.split('\n').filter((l) => l.trim() !== '');
}

function checkWorkflows() {
  const dir = join(REPO, '.github', 'workflows');
  const files = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => /\.ya?ml$/i.test(n))
        .map((n) => [n, readFileSync(join(dir, n), 'utf8')])
    : [];
  const hit = filesWithSkipFlag(files);
  if (hit.length) {
    console.error(`流水线里不许用 ${SKIP_ENV_CHECK}（安全审查 X-4）：${hit.join('、')}`);
    return 1;
  }
  console.log(`流水线检查通过：${files.length} 个文件里没有 ${SKIP_ENV_CHECK}`);
  return 0;
}

function checkPermissions() {
  const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=all', '--', PERMISSIONS], { cwd: REPO, encoding: 'utf8' });
  const dirty = dirtyLines(out);
  if (dirty.length) {
    console.error(`编译后 ${PERMISSIONS} 和提交的不一致（build.rs 登记的命令变了却没提交重新生成的文件？安全审查 X-3）：`);
    for (const l of dirty) console.error(`  ${l}`);
    return 1;
  }
  console.log(`权限文件检查通过：${PERMISSIONS} 和提交的一致`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const what = process.argv[2];
  if (what === 'workflows') process.exit(checkWorkflows());
  if (what === 'permissions') process.exit(checkPermissions());
  console.error('用法：node desktop/src-tauri/scripts/ci-guard.mjs workflows|permissions');
  process.exit(2);
}
