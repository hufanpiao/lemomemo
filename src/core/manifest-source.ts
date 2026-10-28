// 数据清单的来源（架构 3.5）：类型和内容都来自后端写的 shared/（B0 集成时把前端的桩换掉）
// core/manifest.ts 只认这里导出的 manifests，测试可以传别的列表进去
import { allManifests } from '../../shared/manifests/index.ts';

export type { Manifest, ManifestTable } from '../../shared/schema/manifest.ts';

export const manifests = allManifests;
