// 核对 version-gate 的免查名单（架构 0.27 第 1 点、TC-B0-52）：名单里写了、supabase/functions/ 下却没有的函数报错。
// CI 由运维接进流水线。需要 Node 22.18 以上（直接 import .ts）。
//
// 用法：node build/check_version_gate.mjs [--functions-dir <目录>]
// 退出码：0 通过；1 有问题。

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function checkExemptFunctions(exempt, functionsDir) {
  const errors = [];
  const seen = new Set();
  for (const f of exempt) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(f.name)) errors.push(`函数名不合规：${f.name}`);
    if (seen.has(f.name)) errors.push(`名单里重复：${f.name}`);
    seen.add(f.name);
    if (!Array.isArray(f.methods) || f.methods.length === 0) errors.push(`${f.name}：没写方法`);
    const dir = join(functionsDir, f.name);
    if (!existsSync(dir) || !statSync(dir).isDirectory() || !existsSync(join(dir, 'index.ts'))) {
      errors.push(`名单里有、supabase/functions/ 下却没有：${f.name}`);
    }
  }
  return errors;
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--functions-dir');
  const functionsDir = resolve(ROOT, i >= 0 ? args[i + 1] : 'supabase/functions');
  const { EXEMPT_FUNCTIONS } = await import('../functions/sb/version-gate.ts');
  const errors = checkExemptFunctions(EXEMPT_FUNCTIONS, functionsDir);
  if (errors.length) {
    console.error('version-gate 免查名单检查没通过：');
    for (const e of errors) console.error('  ' + e);
    process.exit(1);
  }
  console.log(`version-gate 免查名单检查通过（${EXEMPT_FUNCTIONS.length} 个函数）`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
