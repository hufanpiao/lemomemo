// D1 第 7 节：必须有的索引（whitelist.ts 的 REQUIRED_INDEXES）在不在、定义是不是一字不差。
// 纯函数：入参是 pg_indexes 里 public 的（索引名、indexdef），checks.ts 查库后调用；单测 tests/build/d1-required-indexes.test.ts。
import { REQUIRED_INDEXES } from './whitelist.ts';

export interface IndexRow { n: string; d: string }

/** 空白统一成一个空格再整段比（pg_indexes 的写法各版本一致，留这一步防将来换行） */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function requiredIndexProblems(idx: readonly IndexRow[], want: typeof REQUIRED_INDEXES = REQUIRED_INDEXES): string[] {
  const out: string[] = [];
  for (const [name, r] of Object.entries(want)) {
    const got = idx.find((x) => x.n === name);
    if (!got) out.push(`缺索引 public.${name}（${r.why}）`);
    else if (norm(got.d) !== norm(r.def)) out.push(`索引 public.${name} 的定义不对（${r.why}）`);
  }
  return out;
}
