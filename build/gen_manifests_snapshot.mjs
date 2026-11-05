// 数据清单快照（FA-6 ③）：把 shared/manifests 的 allManifests（每份都经 defineManifest 的 zod 校验、补默认值）
// 原样写成完整快照 src/core/manifests.gen.ts（带类型的常量 manifestSnapshot），core/manifest-source.ts 读它（入队校验、同步用，按需加载）。
// 为什么：清单源文件 import 了 shared/schema/manifest.ts（zod）；读快照就不用把 zod 拉进来。首屏建本机仓只读下面另生成的精简清单。
// 写成 .ts 不写 .json：Node、Playwright 直接 import .json 要带 import 属性（type: json），.ts 哪里都能加载，类型检查还顺带核对快照符合 Manifest。
// 校验没有丢：生成时照样跑 defineManifest；src/core/__tests__/manifest-snapshot.test.ts 每次全量测试都核对快照和源文件一致。
//
// 用法：node build/gen_manifests_snapshot.mjs          重新生成（改了 shared/manifests 或 shared/schema/manifest.ts 以后跑）
//       node build/gen_manifests_snapshot.mjs --check  重新生成后和仓库里的比，不一致退出码 1
// 11-05 首屏瘦身：另生成 src/core/manifest-sync.gen.ts（每张表只留 name、schema、sync、rebuildable，首屏建本机仓用）；
// 完整快照不再进首屏（入队校验随 rows.ts 按需加载）。两份一起生成、一起 --check
// 需要 Node 22.18 以上（直接 import .ts）。
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'src', 'core', 'manifests.gen.ts');
export const OUT_SYNC = join(ROOT, 'src', 'core', 'manifest-sync.gen.ts');

const HEADER = [
  '// 自动生成，不要手改（build/gen_manifests_snapshot.mjs，B2 FA-6 ③）：shared/manifests 经 defineManifest 校验后的结果。',
  '// 改了 shared/manifests 或 shared/schema/manifest.ts 以后跑 node build/gen_manifests_snapshot.mjs',
  '/* eslint-disable max-lines -- 生成的数据，行数随清单走 */',
  "import type { Manifest } from '../../shared/schema/manifest.ts';",
  '',
  '',
].join('\n');

/** 快照里的数据部分：两格缩进；JSON 装不下的值（undefined 以外）直接报错，不悄悄丢 */
export function snapshotJson(list) {
  return JSON.stringify(list, (_k, v) => {
    if (typeof v === 'function' || typeof v === 'bigint' || typeof v === 'symbol' || v instanceof RegExp) {
      throw new Error(`manifests_not_json:${typeof v}`);
    }
    return v;
  }, 2);
}

/** 整个 manifests.gen.ts 的文本（末尾换行） */
export function renderManifests(list) {
  return `${HEADER}export const manifestSnapshot: readonly Manifest[] = ${snapshotJson(list)};\n`;
}

const SYNC_HEADER = [
  '// 自动生成，不要手改（build/gen_manifests_snapshot.mjs，11-05 首屏瘦身）：完整快照 manifests.gen.ts 里每张表的 name、schema、sync、rebuildable，',
  '// 顺序同 allTables（清单顺序、表顺序）。首屏建本机仓（cache-schema.ts 的 syncStores）只要这几项',
  "import type { ManifestTable } from '../../shared/schema/manifest.ts';",
  '',
  "export type SyncTableLite = Pick<ManifestTable, 'name' | 'schema' | 'sync' | 'rebuildable'>;",
  '',
  '',
].join('\n');

/** manifest-sync.gen.ts 的文本：每张表四项（末尾换行） */
export function renderSyncTables(list) {
  const lite = list.flatMap((m) => m.tables.map((t) => ({ name: t.name, schema: t.schema, sync: t.sync, rebuildable: t.rebuildable })));
  return `${SYNC_HEADER}export const syncTableSnapshot: readonly SyncTableLite[] = ${snapshotJson(lite)};\n`;
}

export async function loadManifests() {
  const mod = await import(pathToFileURL(join(ROOT, 'shared', 'manifests', 'index.ts')).href);
  return mod.allManifests;
}

/** 要生成的全部文件和内容（--check、生成都遍历这一份；复审 L1：少了哪份，manifest-snapshot.test.ts 就挂） */
export function outputs(list) {
  return [
    [OUT, renderManifests(list)],
    [OUT_SYNC, renderSyncTables(list)],
  ];
}

/** --check：和仓库里不一致（含读不到）的文件；read 只给测试换 */
export function staleFiles(outs, read = (file) => readFileSync(file, 'utf8')) {
  return outs
    .filter(([file, text]) => {
      let cur = '';
      try {
        cur = read(file).replaceAll('\r\n', '\n');
      } catch {
        cur = '';
      }
      return cur !== text;
    })
    .map(([file]) => file);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outs = outputs(await loadManifests());
  if (process.argv.includes('--check')) {
    const stale = staleFiles(outs);
    for (const file of stale) console.error(`${file} 和 shared/manifests 不一致：跑 node build/gen_manifests_snapshot.mjs 重新生成`);
    if (stale.length) process.exit(1);
    console.log('manifests.gen.ts、manifest-sync.gen.ts 一致');
  } else {
    for (const [file, text] of outs) {
      writeFileSync(file, text, 'utf8');
      console.log(`已写 ${file}`);
    }
  }
}
