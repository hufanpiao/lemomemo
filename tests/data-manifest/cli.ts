// 生成器的命令行：把用例写成 JSON、一份 SQL 清单和一份对象存储探针清单（R2 的桶，0.32），给后端审、给 runner 读；
// 用真清单时另写“表 × 角色 × 操作”的 grant-cases.json / grant-cases.txt（TC-B0-89，0.33）。
//
//   node tests/data-manifest/cli.ts --sample --out <目录>     用样例清单
//   node tests/data-manifest/cli.ts --out <目录>              用 shared/manifests/index.ts（后端写好后）
//
// 真清单读 shared/manifests/index.ts 的 allManifests（后端）。npm run gen:manifest 写到 dist/data-manifest/。需要 Node 22.18 以上。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generate, type GeneratedCase } from './generate.ts';
import { describeGrantCase, generateGrantMatrix } from './grant-matrix.ts';
import { describeObjProbe } from './objstore-cases.ts';
import type { Manifest } from './types.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function loadManifests(sample: boolean): Promise<readonly Manifest[]> {
  if (sample) return (await import('./sample-manifests.ts')).sampleManifests;
  const index = join(ROOT, 'shared', 'manifests', 'index.ts');
  if (!existsSync(index)) throw new Error('还没有 shared/manifests/index.ts（后端写），先用 --sample');
  const mod: { allManifests?: readonly Manifest[] } = await import(pathToFileURL(index).href);
  const list = mod.allManifests;
  if (!Array.isArray(list)) throw new Error('shared/manifests/index.ts 要导出 allManifests 数组');
  return list;
}

function toSql(c: GeneratedCase): string {
  const lines = [`-- ${c.id}（${c.kind}，${c.target}，清单：${c.manifests.join('、')}）`, `-- 期望：${c.expect}`];
  if (c.probe) {
    lines.push(`-- 探针 A：\n${c.probe.a};`);
    if (c.probe.b) lines.push(`-- 探针 B：\n${c.probe.b};`);
  }
  if (c.act && c.act !== 'account-delete') lines.push(`-- 动作：\n${c.act.startsWith('update') || c.act.startsWith('--') ? c.act + ';' : '-- ' + c.act}`);
  return lines.join('\n') + '\n';
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const i = args.indexOf('--out');
  const out = i >= 0 ? resolve(args[i + 1] ?? '') : null;
  const { cases, counts } = generate(await loadManifests(args.includes('--sample')));
  console.log(`生成 ${cases.length} 条：${Object.entries(counts).map(([k, n]) => `${k} ${n}`).join('，')}`);
  if (!out) return;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'cases.json'), JSON.stringify(cases, null, 2) + '\n');
  writeFileSync(join(out, 'cases.sql'), cases.filter((c) => c.runner === 'sql').map(toSql).join('\n'));
  // store = 'r2' 的桶（0.32）：runner 读 cases.json 的 objProbe；这份给人审
  const obj = cases.filter((c) => c.runner === 'objstore');
  const objText = obj.map((c) => [`${c.id}（${c.kind}）：${c.objProbe ? describeObjProbe(c.objProbe) : ''}`, `  期望：${c.expect}`, ''].join('\n'));
  writeFileSync(join(out, 'cases-objstore.txt'), objText.join(''));
  // TC-B0-89：表 × 角色 × 操作（只用真清单：期望要和 build/d1/whitelist.ts 对上，样例清单对不上）。给后端审断言
  if (!args.includes('--sample')) {
    const wl = await import(pathToFileURL(join(ROOT, 'build', 'd1', 'whitelist.ts')).href);
    const grants = generateGrantMatrix(await loadManifests(false), wl);
    writeFileSync(join(out, 'grant-cases.json'), JSON.stringify(grants, null, 2) + '\n');
    const lines = [...grants.cases.map(describeGrantCase), ...grants.rpcCases.map((c) => `${c.id}：${c.expect ? '能执行' : '不能执行'}`)];
    writeFileSync(join(out, 'grant-cases.txt'), lines.join('\n') + '\n');
    console.log(`表 × 角色 × 操作：${grants.cases.length} 格、RPC ${grants.rpcCases.length} 条`);
  }
  console.log(`已写到 ${out}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
