// 函数侧版本门的入口（架构第 6 节、0.27 第 1 点、0.38 第 47 条）：把唯一的免查名单（shared/version-gate-list.ts，
// 经 build/copy_shared.mjs 复制到 _shared/gen/）接到 version-gate-core.ts 上，每个函数实例共用一份 60 秒缓存。
// 只给 index.ts 用（core.ts 要能在 Vitest 里跑，不准 import _shared/gen/；core.ts 里要比版本用 version-gate-core.ts 的 blockedMin）。
//
// 两种用法：
// ① 版本门在 core.ts 里（如 invite-signup：Turnstile、限流之后才查）：index.ts 注入的读配置用 cachedMinClientVersion(loadMin)，
//    core.ts 拿到 min 再用 blockedMin 比较（架构 0.38 第 52 条：超时 1.5 秒、成功缓存 60 秒、失败缓存 10 秒放行）。
// ② 入口处统一查（index.ts 的 Deno.serve 里、调 handle 之前）：
//   const blocked = await versionGate('<函数名>', req, loadMin);
//   if (blocked) return blocked;
// loadMin 用函数现成的 service role 客户端读 app_config：
//   async (signal) => {
//     const { data, error } = await admin.from('app_config').select('min_client_version').eq('id', 1).abortSignal(signal).maybeSingle();
//     if (error) throw new Error('db');
//     return data?.min_client_version ?? null;
//   }
import { FUNCTION_VERSION_EXEMPTIONS } from './gen/version-gate-list.ts';
import { createFnVersionGate, type LoadMin } from './version-gate-core.ts';

const gate = createFnVersionGate({
  exemptions: FUNCTION_VERSION_EXEMPTIONS,
  log: (code) => console.error(`version-gate: ${code}`),
});

/** 太旧回 426 响应，放行返回 null；免查的函数和方法不读配置 */
export function versionGate(fn: string, req: Request, loadMin: LoadMin): Promise<Response | null> {
  return gate.check(fn, req, loadMin);
}

/** 只取 min_client_version（带缓存和超时；读失败返回 null = 放行，只记 gate_config_* 错误码）。loadMin 要把 signal 交给 .abortSignal(signal) */
export function cachedMinClientVersion(loadMin: LoadMin): Promise<string | null> {
  return gate.minClientVersion(loadMin);
}
