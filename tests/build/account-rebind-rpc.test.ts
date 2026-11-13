// TC-B1-85 ⑩（B5 任务单 S3）：account 的 rebind_device 交接必须经 PostgREST 的 rpc（service role）调 private.rebind_device_impl，
// 不准直连数据库（直连时 role 是 none，devices_session_guard() 不认，0.29 续第 119 条①）。
// 静态读源码，不起函数；tests/functions 的 tsconfig 没有 node 类型，所以放在这里。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('rebind_device 经 rpc 交接', () => {
  it('account/index.ts 的 rebindDevice 调 priv.rpc(\'rebind_device_impl\')；account 目录里没有用 SQL 直接调 rebind_device_impl(...) 的写法', () => {
    const idx = read('supabase/functions/account/index.ts');
    expect(idx).toMatch(/async rebindDevice\([^)]*\) \{[\s\S]{0,400}priv\.rpc\('rebind_device_impl'/);
    for (const f of ['index.ts', 'core.ts', 'rebind.ts', 'common.ts']) {
      expect(read(`supabase/functions/account/${f}`), f).not.toMatch(/rebind_device_impl\s*\(/);
    }
  });
});
