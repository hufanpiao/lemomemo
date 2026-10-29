// tests/build/check-arch-binimport*.test.ts 共用（LINT-binimport，10-30 拆文件时从 check-arch-binimport.test.ts 挪来，行为不变）：
// 在临时目录现拼一棵迷你仓库、跑 build/check_arch.py 取 BINIMPORT 报错、只计 check_binimport 本身的耗时
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const ROOT = join(import.meta.dirname, '..', '..');

export interface Item {
  rule: string;
  file: string;
  line: number;
  message: string;
}

// dirs 是模块级的共享状态，安全的前提有两个：一是每个测试文件各自加载一份本模块（vitest 默认 isolate），
// 二是同一文件里的用例按顺序跑、不用 concurrent。关掉 isolate 或改成 concurrent 以后，cleanupDirs 可能删到别的用例还在用的目录
const dirs: string[] = [];
/** 每个测试文件 afterEach(cleanupDirs)：删掉本条用例 repo() 建的临时目录 */
export function cleanupDirs(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

export function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lemo-binimport-'));
  dirs.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
}

export function binimport(root: string): { code: number; errors: Item[] } {
  const args = ['-I', join(ROOT, 'build', 'check_arch.py'), '--root', root, '--json', '--today', '2026-10-28'];
  let code = 0;
  let out: string;
  try {
    out = execFileSync('python', args, { encoding: 'utf8' });
  } catch (e) {
    const err = e as { status: number; stdout: string };
    code = err.status;
    out = err.stdout;
  }
  const report = JSON.parse(out) as { errors: Item[] };
  return { code, errors: report.errors.filter((x) => x.rule === 'BINIMPORT') };
}

export const where = (errors: Item[]) => errors.map((e) => `${e.file}:${e.line}`);
export const lines = (...ls: string[]) => ls.join('\n');

/** 只计 check_binimport 本身的耗时（不算 python 启动、模块加载）；errors 是“文件:行号”列表 */
export function timed(root: string): { seconds: number; errors: string[] } {
  const script = [
    'import importlib.util, json, pathlib, sys, time',
    'spec = importlib.util.spec_from_file_location("check_arch", sys.argv[1])',
    'mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)',
    'errors = []; t = time.perf_counter(); mod.check_binimport(pathlib.Path(sys.argv[2]), errors)',
    'print(json.dumps({"seconds": time.perf_counter() - t, "errors": [f"{e[1]}:{e[2]}" for e in errors]}))',
  ].join('\n');
  const args = ['-I', '-c', script, join(ROOT, 'build', 'check_arch.py'), root];
  return JSON.parse(execFileSync('python', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })) as { seconds: number; errors: string[] };
}
