// FA-6 ③：完整快照（core/manifests.gen.ts，入队校验、同步用，按需加载）和精简清单（core/manifest-sync.gen.ts，首屏建本机仓用）
// 都必须和 shared/manifests 经 defineManifest 校验后的结果一致
// 不一致就跑 node build/gen_manifests_snapshot.mjs 重新生成
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { allManifests } from '../../../shared/manifests/index.ts';
import { OUT, OUT_SYNC, outputs, renderManifests, renderSyncTables, staleFiles } from '../../../build/gen_manifests_snapshot.mjs';
import { syncStores } from '../cache-schema.ts';
import { syncTableSnapshot } from '../manifest-sync.gen.ts';
import { allTables } from '../manifest-tables.ts';
import { manifests } from '../manifest-source.ts';

describe('清单快照 manifests.gen.ts', () => {
  it('和 shared/manifests 一致（改了清单要重新生成）', () => {
    expect(manifests).toStrictEqual(JSON.parse(JSON.stringify(allManifests)));
  });

  it('清单里没有 JSON 装不下、会被悄悄丢掉的值（undefined 也不行）', () => {
    expect(JSON.parse(JSON.stringify(allManifests))).toStrictEqual(allManifests);
  });

  it('仓库里的文件逐字等于生成结果（--check 同一口径）', () => {
    expect(readFileSync(OUT, 'utf8').replaceAll('\r\n', '\n')).toBe(renderManifests(allManifests));
  });

  it('首屏瘦身 11-05：manifest-sync.gen.ts 逐字等于生成结果，四项和完整快照逐表一致', () => {
    expect(readFileSync(OUT_SYNC, 'utf8').replaceAll('\r\n', '\n')).toBe(renderSyncTables(allManifests));
    const full = allTables(manifests).map((t) => ({ name: t.name, schema: t.schema, sync: t.sync, rebuildable: t.rebuildable }));
    expect(syncTableSnapshot).toStrictEqual(full);
    // 不传清单建的同步仓（读 manifest-sync.gen.ts）和用完整清单建的一模一样
    expect(syncStores()).toStrictEqual(syncStores(manifests));
  });

  it('审查 L1：生成、--check 都覆盖两份文件；哪一份过期、读不到都报出来', () => {
    const outs = outputs(allManifests) as [string, string][];
    expect(outs.map(([f]) => f)).toEqual([OUT, OUT_SYNC]);
    const good = new Map(outs);
    expect(staleFiles(outs, (f: string) => good.get(f) ?? '')).toEqual([]);
    expect(staleFiles(outs, (f: string) => (f === OUT_SYNC ? 'old' : (good.get(f) ?? '')))).toEqual([OUT_SYNC]);
    expect(staleFiles(outs, (f: string) => (f === OUT ? 'old' : (good.get(f) ?? '')))).toEqual([OUT]);
    expect(
      staleFiles(outs, (f: string) => {
        if (f === OUT_SYNC) throw new Error('ENOENT');
        return good.get(f) ?? '';
      }),
    ).toEqual([OUT_SYNC]);
    // 主程序的 --check、生成都遍历 outputs() 的全部，不许只取一份
    const src = readFileSync(join(import.meta.dirname, '..', '..', '..', 'build', 'gen_manifests_snapshot.mjs'), 'utf8');
    expect(src).toContain('const outs = outputs(await loadManifests());');
    expect(src).toContain('const stale = staleFiles(outs);');
    expect(src).toContain('for (const [file, text] of outs) {');
  });

  it('精简清单里没有重名表（它不经 allTables 的重复检查，审查 L2）', () => {
    const keys = syncTableSnapshot.map((t) => `${t.schema}.${t.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('函数、正则之类装不进 JSON 的值直接报错', () => {
    expect(() => renderManifests([{ a: /x/ }])).toThrow('manifests_not_json');
    expect(() => renderManifests([{ a: () => 1 }])).toThrow('manifests_not_json');
  });

  it('③ 审查 L5：--check 接进了 check:manifests 和构建（unit.yml 跑 preview 构建就查到，第三方审查 CI-9 起不再单跑一步），构建在 vite build 之前先查（过期快照进不了预览）', () => {
    const read = (f: string) => readFileSync(join(import.meta.dirname, '..', '..', '..', f), 'utf8');
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    expect(scripts['check:manifests']).toBe('node build/gen_manifests_snapshot.mjs --check');
    expect(read('.github/workflows/unit.yml')).toContain('run: npm run build -- --mode preview');
    // 构建在 vite build 之前先查、过期就不构建：tests/build/build-web.test.ts 换成假步骤按行为核
  });
});
