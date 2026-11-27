// supabase/functions/_shared/auth.ts 的 requireActiveUser、isUsable：在 Deno（服务器函数的运行环境）下跑 auth-check.mjs 的全部分支
// 含 TC-B1-111（架构 0.36 第 1 条 ②）：amr 里有 password 的会话回 401 unauthorized，otp、magiclink、recovery 照常
// 用 .mjs：deno test 会选中，Vitest（只认 *.test.ts）和 tsc（tests/**/*.ts）不碰它——auth.ts 里的 npm: 写法只有 Deno 认
import { checkAuth } from '../../supabase/tests/offline/auth-check.mjs';

Deno.test('requireActiveUser、isUsable：各分支（含密码会话被拒）', async () => {
  const { n, fails } = await checkAuth();
  if (fails.length) throw new Error(`${fails.length} 处不对（共 ${n}）：\n` + fails.join('\n'));
});
