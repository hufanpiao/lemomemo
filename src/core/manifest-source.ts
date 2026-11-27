// 数据清单的来源：类型和内容都来自后端写的 shared/
// core/manifest.ts 只认这里导出的 manifests，测试可以传别的列表进去
// 内容读 build/gen_manifests_snapshot.mjs 生成的完整快照 manifests.gen.ts（shared/manifests 经 defineManifest 校验后的结果原样写出），
// 因为 shared/manifests 引着 zod。完整快照不进首屏：入队校验（outbox-logic.ts 的 loadRowSchemas）、同步按需加载本文件；
// 首屏建本机仓只读精简清单 manifest-sync.gen.ts。快照和源文件不一致时 __tests__/manifest-snapshot.test.ts 失败
import type { Manifest } from '../../shared/schema/manifest.ts';
import { manifestSnapshot } from './manifests.gen.ts';

export type { Manifest, ManifestTable } from '../../shared/schema/manifest.ts';

export const manifests: readonly Manifest[] = manifestSnapshot;
