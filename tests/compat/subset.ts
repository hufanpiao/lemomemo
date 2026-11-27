// 旧版客户端契约测试子集名单的格式（架构 0.27 第 1 点“子集名单放在 tests/compat/”；开发计划 v4 三之二）
// B0 集成：前端 A 的 harness（按 id）和前端 B 的 run-compat（按文件）合成一份 —— 每条用例同时写 id 和所在文件：
//   { "version": 1, "cases": [ { "id": "headers.app-version", "file": "tests/compat/headers.test.ts" }, … ] }
// - file 以 .test.ts 结尾：Vitest 用例，文件里用 contract(id, …) 登记；子集模式下 harness 只跑名单里的 id
// - file 以 .sql 结尾：SQL 用例，由 sql-case.ts 在事务里跑，返回一行 result = 'ok'
// 只用标准 JS：harness（Vitest）、run-compat（Node）、离线 SQL 检查（Node）都读它；基线那一版的名单也用同一个函数解析
// 本文件不 import 任何东西：基线的 tests/compat/ 会被单独取出来跑

export interface CompatCase {
  /** 稳定的用例 id：小写字母数字，用 . 或 - 分段 */
  id: string;
  /** 相对仓库根目录的路径，必须在 tests/compat/ 下 */
  file: string;
}

export interface Subset {
  version: 1;
  cases: CompatCase[];
}

export const CASE_ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/;
const FILE_RE = /^tests\/compat\/[\w./-]+\.(test\.ts|sql)$/;

/** 解析并校验 subset.json 的内容（字符串或已解析的对象）；不合规直接抛错 */
export function parseSubset(input: unknown): Subset {
  const raw: unknown = typeof input === 'string' ? JSON.parse(input) : input;
  if (!raw || typeof raw !== 'object') throw new Error('subset.json 不是对象');
  const o = raw as { version?: unknown; cases?: unknown };
  if (o.version !== 1) throw new Error('subset.json 的 version 必须是 1');
  if (!Array.isArray(o.cases)) throw new Error('subset.json 的 cases 必须是数组');
  const seen = new Set<string>();
  const cases: CompatCase[] = [];
  for (const c of o.cases as unknown[]) {
    const { id, file } = (c ?? {}) as { id?: unknown; file?: unknown };
    if (typeof id !== 'string' || !CASE_ID_RE.test(id)) throw new Error(`subset.json 里的 id 不合规：${String(id)}`);
    if (typeof file !== 'string' || file.includes('..') || !FILE_RE.test(file)) throw new Error(`subset.json 里的路径不合规：${String(file)}`);
    if (seen.has(id)) throw new Error(`subset.json 里的 id 重复：${id}`);
    seen.add(id);
    cases.push({ id, file });
  }
  return { version: 1, cases };
}

/** 子集里的 Vitest 用例文件（去重） */
export const testFiles = (s: Subset): string[] => [...new Set(s.cases.filter((c) => c.file.endsWith('.test.ts')).map((c) => c.file))];

/** 子集里的 SQL 用例 */
export const sqlCases = (s: Subset): CompatCase[] => s.cases.filter((c) => c.file.endsWith('.sql'));
