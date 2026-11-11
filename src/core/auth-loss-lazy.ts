// resolveAuthLoss 的懒加载入口（R-382）：core/auth-loss.ts 连着 session_fate 查询、哈希和 lemo.authloss，只在会话丢了时才用得上，
// 不进首屏。account.ts、account-leave.ts、app/sync-wiring.ts、设置页经这里调（结局本来就是异步的）；类型照常从 auth-loss.ts 用 import type 引
// appFetch、readInstallId 在这里（首屏）传进去：懒加载那几个文件不 import 首屏模块，免得首屏多拆一块（见 platform/auth-loss-log.ts 开头）
import type { AuthLossOutcome, AuthLossSignal, ResolveDeps } from './auth-loss.ts';
import { readInstallId } from '../platform/device-info.ts';
import { appFetch } from '../platform/http.ts';

export function resolveAuthLossLazy(signal: AuthLossSignal, deps?: ResolveDeps): Promise<AuthLossOutcome> {
  return import('./auth-loss.ts').then((m) => m.resolveAuthLoss(signal, { fetch: appFetch, installId: () => readInstallId(), ...deps }));
}
