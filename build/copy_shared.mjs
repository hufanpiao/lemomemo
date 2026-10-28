// 把 /shared 复制到 supabase/functions/_shared/gen/（架构 2.5：Edge Functions 用同一份 shared）
// • 生成目录不进仓库（.gitignore），CI 部署函数前再跑一遍；不要手改
// • 'zod' 改写成 'npm:zod@<package.json 里的版本>'，函数那边不依赖 import map 也能解析
// • 相对 import 必须带 .ts 后缀（Deno 要求），缺了直接失败
// 用法：node build/copy_shared.mjs [输出目录]
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..');
const HEADER = '// 生成文件：由 build/copy_shared.mjs 从 /shared 复制，不要手改\n';
const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\2/g;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 改写一个文件的 import；返回新内容和发现的问题 */
export function rewrite(code, file, zodVersion) {
  const problems = [];
  const out = code.replace(IMPORT_RE, (all, pre, q, spec) => {
    if (spec === 'zod') return `${pre}${q}npm:zod@${zodVersion}${q}`;
    if (spec.startsWith('.')) {
      if (!spec.endsWith('.ts')) problems.push(`${file}：相对 import 要带 .ts 后缀（${spec}）`);
      return all;
    }
    if (spec.startsWith('npm:') || spec.startsWith('jsr:')) return all;
    problems.push(`${file}：shared 只能 import zod 和自己的文件（${spec}）`);
    return all;
  });
  return { code: HEADER + out, problems };
}

export function copyShared(outDir = join(ROOT, 'supabase', 'functions', '_shared', 'gen')) {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const zodVersion = pkg.dependencies.zod;
  const src = join(ROOT, 'shared');
  const files = walk(src);
  const problems = [];
  const outputs = [];
  for (const f of files) {
    const rel = relative(src, f).split('\\').join('/');
    const r = rewrite(readFileSync(f, 'utf8'), rel, zodVersion);
    problems.push(...r.problems);
    outputs.push([rel, r.code]);
  }
  if (problems.length > 0) throw new Error(`copy_shared 失败：\n${problems.join('\n')}`);
  rmSync(outDir, { recursive: true, force: true });
  for (const [rel, code] of outputs) {
    const dst = join(outDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, code, 'utf8');
  }
  return outputs.map(([rel]) => rel);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const files = copyShared(process.argv[2]);
  console.log(`copy_shared：${files.length} 个文件 → ${process.argv[2] ?? 'supabase/functions/_shared/gen/'}`);
}
