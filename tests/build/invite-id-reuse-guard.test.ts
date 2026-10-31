// 固定 invite-signup 用户 id 派生的前提（安全复核建议；wire.ts signupUserId 注释、迁移 20261031150000 文件头）：
// id 由“邮箱哈希 + 码哈希”确定地派生，注销清除后同邮箱同码若还能再注册就会复用旧 id。现在靠两点挡住，这里把它们钉死：
//   ① invite-admin 建的码只能用 1 次；② 码有效期 ≤ 注销冷静期（清除时码一定已过期）。
// 这里失败 = 有人放开了多次码或拉长了有效期 / 缩短了冷静期：先给 pending_signups 加首次发码生成、重发保留的随机数参与派生，再改这里。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const MIG = join(ROOT, 'supabase', 'migrations');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
// 从 invite-admin/core.ts 源码读常量（不 import：这个 tsconfig 下 import 会把 Deno 侧的 Web Crypto 类型带进来）
const ADMIN = read('supabase', 'functions', 'invite-admin', 'core.ts');
function constOf(name: string): number {
  const m = new RegExp(`export const ${name} = ([0-9_ *]+);`).exec(ADMIN);
  expect(m, `invite-admin/core.ts 里 ${name} 的写法认不出`).not.toBeNull();
  return (m?.[1] ?? '').split('*').reduce((a, x) => a * Number(x.trim().replace(/_/g, '')), 1);
}
const INVITE_MAX_USES = constOf('INVITE_MAX_USES');
const INVITE_TTL_S = constOf('INVITE_TTL_S');

/** 最后一个（按文件名）建 private.account_request_deletion 的迁移里，purge_after 用的冷静期天数 */
function coolingDays(): number {
  const files = readdirSync(MIG).filter((f) => f.endsWith('.sql')).sort();
  let days: number | null = null;
  for (const f of files) {
    const s = readFileSync(join(MIG, f), 'utf8');
    const i = s.search(/create\s+(or\s+replace\s+)?function\s+private\.account_request_deletion\s*\(/i);
    if (i < 0) continue;
    const body = s.slice(i, s.indexOf('$$;', i));
    const all = [...body.matchAll(/now\(\)\s*\+\s*interval\s*'(\d+)\s+days?'/gi)].map((m) => Number(m[1]));
    expect(all.length, `${f} 里 account_request_deletion 的冷静期写法认不出`).toBe(1);
    days = all[0] ?? null;
  }
  expect(days, '没找到 account_request_deletion 的定义').not.toBeNull();
  return days as number;
}

describe('invite-signup 派生 id 不会在注销后复用（安全复核建议）', () => {
  it('invite-admin 建的码只能用 1 次，而且建码时用的就是这个常量', () => {
    expect(INVITE_MAX_USES).toBe(1);
    expect(ADMIN).toMatch(/max_uses:\s*INVITE_MAX_USES\b/);
  });

  it('码有效期不超过注销冷静期（清除不早于注册 + 冷静期，注册不早于建码，所以清除时码已过期）', () => {
    expect(ADMIN).toMatch(/now \+ INVITE_TTL_S \* 1000/);
    expect(INVITE_TTL_S).toBe(7 * 86400);
    const days = coolingDays();
    expect(days).toBe(7);
    expect(INVITE_TTL_S).toBeLessThanOrEqual(days * 86400);
  });

  it('invites 表 max_uses 默认值仍是 1（负责人手工插码不写 max_uses 时也是一次性）', () => {
    expect(read('supabase', 'migrations', '0001_core.sql')).toMatch(/max_uses int default 1,/);
    const later = readdirSync(MIG).filter((f) => f > '0001_core.sql' && f.endsWith('.sql')).map((f) => readFileSync(join(MIG, f), 'utf8'));
    expect(later.filter((s) => /alter\s+column\s+max_uses/i.test(s))).toEqual([]);
  });
});
