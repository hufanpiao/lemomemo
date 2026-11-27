// 功能文件夹的数据清单（架构 3.5 第 5 点、架构约定“每个功能自带”；接手清单 MANIFEST-settings-prefix）
// • 有清单的功能（shared/manifests 里 owner = feature 的）在自己的文件夹里有 data.manifest.ts，re-export 的就是 shared 里那一个对象
// • settings 键前缀各功能自己声明、不重复声明；功能代码里写死的 settings 键（data/ 里的 KEY_xxx = '前缀.名字'）都被某个清单的前缀盖住，
//   日历的 cal.* 归 calendar 清单（不再挂在 core 上）
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { allManifests } from '../../shared/manifests/index.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const FEATURES = join(ROOT, 'src', 'features');
/** 清单的 feature 名 → 功能文件夹名（只有 search 不同名） */
const FOLDER: Readonly<Record<string, string>> = { search: 'smart-search' };

const covers = (prefix: string, key: string): boolean => (prefix.endsWith('.*') ? key.startsWith(prefix.slice(0, -1)) : key === prefix);

/**
 * src/features/<功能>/data/*.ts 里形如 `export const KEY_X = 'a.b'` 的 settings 键（可带类型注解、单双引号、数字）。
 * 口径：功能的 settings 键约定写成 data/ 里的 KEY_ 常量；core 自己的键（ai.enabled 等）由 core 清单的前缀管，不在这里扫（审查 L1）
 */
function settingKeysInCode(): { feature: string; key: string }[] {
  const out: { feature: string; key: string }[] = [];
  for (const feature of readdirSync(FEATURES)) {
    let files: string[];
    try {
      files = readdirSync(join(FEATURES, feature, 'data')).filter((f) => f.endsWith('.ts'));
    } catch {
      continue;
    }
    for (const f of files) {
      const src = readFileSync(join(FEATURES, feature, 'data', f), 'utf8');
      for (const m of src.matchAll(/export const KEY_\w+(?:\s*:\s*[\w<>'" |]+)?\s*=\s*['"]([a-z][a-z0-9_]*\.[a-z0-9_.]+)['"]/g)) if (m[1]) out.push({ feature, key: m[1] });
    }
  }
  return out;
}

describe('功能文件夹的数据清单（MANIFEST-settings-prefix）', () => {
  const features = allManifests.filter((m) => m.feature !== 'core');

  it.each(features.map((m) => [m.feature, m] as const))('%s：功能文件夹里有 data.manifest.ts，re-export 的就是 shared 里的清单', async (name, m) => {
    // 按文件路径导入（带变量的相对路径 import 要靠 Vite 的 dynamic-import-vars，换个环境就解析不了）
    const url = pathToFileURL(join(FEATURES, FOLDER[name] ?? name, 'data.manifest.ts')).href;
    const mod = (await import(/* @vite-ignore */ url)) as Record<string, unknown>;
    expect(Object.values(mod)).toEqual([m]);
    expect(Object.values(mod)[0]).toBe(m);
  });

  it('settings 键前缀不重复声明；cal.* 归 calendar', () => {
    const owners = new Map<string, string[]>();
    for (const m of allManifests) for (const p of m.settingsKeys) owners.set(p, [...(owners.get(p) ?? []), m.feature]);
    expect([...owners].filter(([, o]) => o.length > 1)).toEqual([]);
    expect(owners.get('cal.*')).toEqual(['calendar']);
  });

  it('功能代码里写死的 settings 键都被某个清单的前缀盖住；日历的键被 calendar 自己的清单盖住', () => {
    const keys = settingKeysInCode();
    expect(keys.map((k) => k.key)).toEqual(expect.arrayContaining(['cal.holidays', 'cal.week_start']));
    const all = allManifests.flatMap((m) => m.settingsKeys);
    expect(keys.filter((k) => !all.some((p) => covers(p, k.key)))).toEqual([]);
    const cal = allManifests.find((m) => m.feature === 'calendar')?.settingsKeys ?? [];
    expect(keys.filter((k) => k.feature === 'calendar' && !cal.some((p) => covers(p, k.key)))).toEqual([]);
  });
});
