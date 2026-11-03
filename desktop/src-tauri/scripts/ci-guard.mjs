#!/usr/bin/env node
// exe 流水线的两道检查（安全审查外壳 X-3、X-4），由运维接进 desktop.yml（F9）：
//   node desktop/src-tauri/scripts/ci-guard.mjs workflows     —— 编译前：.github/workflows、.github/actions（含子目录里的所有文件）
//                                                               和 package.json 的 scripts 里一出现 --skip-env-check 就失败（复核 X-S8）；
//                                                               B6-exe 安全审查建议 2 加宽：仓库里所有 package.json（除 node_modules）的 scripts、
//                                                               desktop/src-tauri/tauri*.json（beforeBuildCommand 等）、build/ci/ 下的脚本也查；
//                                                               工作流、复合动作里把 CI / GITHUB_ACTIONS 设成空、false、0（或 unset、env -u）也失败——
//                                                               stage-web 在 CI 里拒绝跳过参数靠的就是这两个变量。参数拼接（--skip-env-${x}）静态查不出，靠代码审查
//   node desktop/src-tauri/scripts/ci-guard.mjs permissions   —— 编译后：tauri-build 重新生成的权限文件和提交的不一致就失败
// （等于 git diff --exit-code，另外把没提交的新文件也算作不一致）
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKIP_ENV_CHECK } from './stage-web.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const PERMISSIONS = 'desktop/src-tauri/permissions';

/** 哪些流水线文件里出现了 --skip-env-check：files 是 [文件名, 内容] */
export function filesWithSkipFlag(files) {
  return files.filter(([, text]) => text.includes(SKIP_ENV_CHECK)).map(([name]) => name);
}

/** package.json 里哪些 scripts 带了 --skip-env-check：返回 "scripts.<名字>" 列表；JSON 读不出来直接抛错（宁可失败） */
export function scriptsWithSkipFlag(pkgText) {
  const scripts = JSON.parse(pkgText).scripts ?? {};
  return Object.entries(scripts)
    .filter(([, cmd]) => String(cmd).includes(SKIP_ENV_CHECK))
    .map(([name]) => `scripts.${name}`);
}

function walkFiles(dir, base = dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, base, out);
    else if (e.isFile()) out.push([relative(base, p).replaceAll('\\', '/'), readFileSync(p, 'utf8')]);
  }
  return out;
}

/** 找 package.json 时不进的目录 */
const PKG_SKIP_DIRS = new Set(['node_modules', '.git', 'target', 'dist', '.wrangler', '.e2e-sb']);

/** 仓库里所有 package.json（相对仓库根），不进 node_modules 等目录 */
export function findPackageJsons(root, dir = root, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!PKG_SKIP_DIRS.has(e.name)) findPackageJsons(root, p, out);
    } else if (e.isFile() && e.name === 'package.json') out.push(relative(root, p).replaceAll('\\', '/'));
  }
  return out.sort();
}

/**
 * 工作流、复合动作里有没有把 CI / GITHUB_ACTIONS 清掉：YAML 里设成空、false、0、null、~；shell 里 unset、env -u、CI= 前缀、
 * CI=false / 0；PowerShell 里 $env:CI = '' / $null / false、Remove-Item env:CI。files 是 [文件名, 内容]，返回 "文件名:行号" 列表
 */
export function filesClearingCiEnv(files) {
  const yamlKey = /^\s*-?\s*(CI|GITHUB_ACTIONS)\s*:\s*(?:(['"])(?:|false|0)\2|false|0|null|~)?\s*(#.*)?$/i;
  const shell =
    /(?:^|[\s;&|(])(?:unset\s+(?:[\w-]+\s+)*(?:CI|GITHUB_ACTIONS)\b|env\s+(?:-\S+\s+)*-u\s*(?:CI|GITHUB_ACTIONS)\b|(?:CI|GITHUB_ACTIONS)=(?:['"]{2}|false\b|0\b|(?=\s|$)))/i;
  const ps = /\$env:(CI|GITHUB_ACTIONS)\s*=\s*(?:['"]{2}|\$null|['"]?(?:false|0)['"]?)|Remove-Item\s+(?:-Path\s+)?['"]?env:(?:CI|GITHUB_ACTIONS)\b/i;
  const hits = [];
  for (const [name, text] of files) {
    text.split(/\r?\n/).forEach((line, i) => {
      if (yamlKey.test(line) || shell.test(line) || ps.test(line)) hits.push(`${name}:${i + 1}`);
    });
  }
  return hits;
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
  // .github/actions 下的复合动作（action.yml）和它调用的脚本都可能带参数，整个目录逐个文件查
  const actions = walkFiles(join(REPO, '.github', 'actions')).map(([n, t]) => [`.github/actions/${n}`, t]);
  // 所有 package.json 的 scripts、tauri*.json（beforeBuildCommand、beforeBundleCommand 等）、build/ci/ 下的脚本（安全审查建议 2）
  const pkgs = findPackageJsons(REPO);
  const tauri = readdirSync(join(REPO, 'desktop', 'src-tauri'))
    .filter((n) => /^tauri.*\.json$/i.test(n))
    .map((n) => [`desktop/src-tauri/${n}`, readFileSync(join(REPO, 'desktop', 'src-tauri', n), 'utf8')]);
  const buildCi = walkFiles(join(REPO, 'build', 'ci')).map(([n, t]) => [`build/ci/${n}`, t]);
  const flows = [...files.map(([n, t]) => [`.github/workflows/${n}`, t]), ...actions];
  const hit = [
    ...filesWithSkipFlag(flows),
    ...pkgs.flatMap((p) => scriptsWithSkipFlag(readFileSync(join(REPO, p), 'utf8')).map((n) => `${p} ${n}`)),
    ...filesWithSkipFlag(tauri),
    ...filesWithSkipFlag(buildCi),
  ];
  const cleared = filesClearingCiEnv(flows);
  if (cleared.length) {
    console.error(`流水线里不许把 CI / GITHUB_ACTIONS 清空或设成 false（stage-web 靠它们拒绝 ${SKIP_ENV_CHECK}，安全审查建议 2）：${cleared.join('、')}`);
    return 1;
  }
  if (hit.length) {
    console.error(`流水线里不许用 ${SKIP_ENV_CHECK}（安全审查 X-4）：${hit.join('、')}`);
    return 1;
  }
  console.log(
    `流水线检查通过：workflows ${files.length} 个、actions ${actions.length} 个文件、package.json ${pkgs.length} 个的 scripts、` +
      `tauri 配置 ${tauri.length} 个、build/ci ${buildCi.length} 个文件里都没有 ${SKIP_ENV_CHECK}，也没有清掉 CI / GITHUB_ACTIONS`,
  );
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
