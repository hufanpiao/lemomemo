// tests/build/check-backend*.test.ts 共用（10-30 拆文件时从 check-backend.test.ts 挪来，行为不变）：
// 跑 build/check_backend.py --json 取报错、样例目录、报错位置排序
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { FIXTURES, ROOT } from '../arch/fixture-header.ts';

export interface Item {
  rule: string;
  file: string;
  line: number;
  message: string;
}

export function run(root: string, extra: string[] = [], env: Record<string, string> = {}): { code: number; errors: Item[] } {
  const args = ['-I', join(ROOT, 'build', 'check_backend.py'), '--root', root, '--json', ...extra];
  try {
    const out = execFileSync('python', args, { encoding: 'utf8', env: { ...process.env, ...env } });
    return { code: 0, errors: (JSON.parse(out) as { errors: Item[] }).errors };
  } catch (e) {
    const err = e as { status: number; stdout: string };
    return { code: err.status, errors: (JSON.parse(err.stdout) as { errors: Item[] }).errors };
  }
}

export const sample = (name: string) => join(FIXTURES, 'check_backend', name);
/** 真名单已清空（r2-probe 10-28 下线）；F6 的样例按“名单里有 r2-probe”跑，证明名单里的照规则放行、名单外的照样拦 */
export const SAMPLE_PREVIEW = ['--sample-preview-funcs', 'r2-probe'];
/** check-backend*.test.ts 都在 Vitest 的 node-slow 项目里（vitest.config.ts 的 SLOW_NODE_TESTS），每条用例默认已是 30 秒（迷你样例单跑约 0.3～1.7 秒）。
 *  真跑 python 扫描整个仓库、或一条里连跑 3 次的两条用例工作量是别的几倍（单跑 2～3.5 秒），再单独放到 60 秒 */
export const SLOW_TIMEOUT = 60_000;
export const where = (errors: Item[]) => errors.map((e) => `${e.rule} ${e.file}:${e.line}`).sort();
