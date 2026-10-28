// 功能开关（架构 0.27 第 4 点）：判断只写这一份，前端 app/features.ts 和 Edge Functions 共用
import { parseVersion, versionAtLeast } from '../core/version.ts';

/** app_config.features 里的一项，例如 {"on": true, "min_client": "4.1.0"} */
export interface FeatureFlag {
  on: boolean;
  min_client?: string;
}

/** app_config.features：以开关名为键（4.0.0 只有 event、todo、note、anniv） */
export type FeaturesConfig = Readonly<Record<string, FeatureFlag | undefined>>;

export interface FeatureCtx {
  /** profiles.beta_features：先给这个人打开的功能 */
  beta: readonly string[];
  /** 发请求的客户端版本（前端用 build-info 的版本，函数用 X-App-Version） */
  appVersion: string;
}

/**
 * 开关是否对这个人打开：`on` 为真或 key 在本人的 beta_features 里，并且版本不低于 min_client。
 * 配置里没有这个键、版本号解析不了：一律当作关闭（失败就关上）。
 */
export function featureOn(cfg: FeaturesConfig, key: string, ctx: FeatureCtx): boolean {
  const f = cfg[key];
  if (!f) return false;
  if (!(f.on || ctx.beta.includes(key))) return false;
  if (f.min_client === undefined) return true;
  if (!parseVersion(ctx.appVersion) || !parseVersion(f.min_client)) return false;
  return versionAtLeast(ctx.appVersion, f.min_client);
}
