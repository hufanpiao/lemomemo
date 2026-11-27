// 重新生成 tests/shared/golden.json（时刻函数或日期模板改了才需要；生成后人工看 git diff）
// 用法：node build/update_golden.mjs    （Node 24 直接跑 .ts，不需要编译）
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

process.env.TZ = 'UTC';
const { computeGolden } = await import('../tests/shared/golden-cases.ts');
const rows = computeGolden();
const out = join(import.meta.dirname, '..', 'tests', 'shared', 'golden.json');
writeFileSync(out, `[\n${rows.map((r) => `  ${JSON.stringify(r)}`).join(',\n')}\n]\n`, 'utf8');
console.log(`golden.json：${rows.length} 行`);
