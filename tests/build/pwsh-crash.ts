// pwsh 自身启动崩溃时整次重跑一遍（login-token-fake.ts 的 runScript 用；测试见 login-token-fake-retry.test.ts）。
// CI 的 runner 上 pwsh 7.6.9（.NET 10）偶发在后台加载程序集时崩溃：stderr 里 Unhandled exception. System.IO.FileLoadException，退出码 null；
// 10-31 c935906、11-10 各挂过一次 unit，和脚本无关。不固定 pwsh 版本，unit.yml 在测试前打印 pwsh --version

/** 只认 stderr 里这两段同时出现 */
export const PWSH_CRASH = /Unhandled exception\.[\s\S]*System\.IO\.FileLoadException/;
export const PWSH_CRASH_MESSAGE = 'pwsh 自身崩溃（.NET FileLoadException），不是脚本问题';

/**
 * 跑一次 run；认出 pwsh 自身崩溃就整次再跑一遍（每次 run 都要自带独立的假服务，重跑才没有副作用）。
 * 返回最后成功启动的那一次，断言只看它；还崩就抛 PWSH_CRASH_MESSAGE，带上 stderr 末尾
 */
export async function retryOnPwshCrash<T extends { err: string; code: number | null }>(run: () => Promise<T>): Promise<T> {
  const first = await run();
  if (!PWSH_CRASH.test(first.err)) return first;
  console.warn(`[pwsh-crash] ${PWSH_CRASH_MESSAGE}，整次重跑一遍`);
  const second = await run();
  if (!PWSH_CRASH.test(second.err)) return second;
  throw new Error(`${PWSH_CRASH_MESSAGE}：连着两次都在启动时崩了（退出码 ${second.code}）。stderr 末尾：\n${second.err.slice(-800)}`);
}
