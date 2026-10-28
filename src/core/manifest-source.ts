// 【桩】数据清单的来源（架构 3.5）。
// 清单的类型（shared/schema/manifest.ts）和内容（shared/manifests/）由架构师定格式、后端在 B0 写。
// 那两份还没进主干，这里先放前端用得到的最小子集，免得和后端的文件撞车。
// 后端的版本合并后：把本文件改成
//   export type { Manifest, ManifestTable } from '../../shared/schema/manifest.ts';
//   export { manifests } from '../../shared/manifests/index.ts';
// 其余代码（core/manifest.ts）不用动。

export interface ManifestTable {
  name: string;
  schema: 'public' | 'private';
  sync: boolean;
  realtime: boolean;
  localCache: 'plain' | 'cipher-only' | 'none';
  clientWritable: readonly string[];
  softDelete: boolean;
  /** 本机库迁移出错时能不能清空重拉（0.27） */
  rebuildable?: boolean;
}

export interface Manifest {
  feature: string;
  owner: 'core' | 'feature';
  tables: readonly ManifestTable[];
}

/** 桩：B0 前端骨架只要求“汇总能跑”，内容等后端的核心清单 */
export const manifests: readonly Manifest[] = [];
