// 正式产物里不能有 R-68 探测页和 voice-probe（B3 Q1 ⑧）：check_no_probe.mjs 搜得到、搜不到；构建脚本和发布流水线都接上了；
// 探测页只从试验页懒加载、平台层文件只被探测页引用（正式版没有试验页，整块摇掉）
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findProbe, PROBE_MARKERS } from '../../build/check_no_probe.mjs';

const root = resolve(import.meta.dirname, '..', '..');
let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

function fixture(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'probe-'));
  for (const [p, text] of Object.entries(files)) {
    const f = join(dir, p);
    mkdirSync(resolve(f, '..'), { recursive: true });
    writeFileSync(f, text);
  }
  return dir;
}

describe('findProbe', () => {
  it('干净的产物 → 空', () => {
    expect(findProbe(fixture({ 'app/assets/a.js': 'const x = "/functions/v1/ai-voice";', 'index.html': '<p>hi</p>' }))).toEqual([]);
  });

  it.each(PROBE_MARKERS)('子目录里搜到 %s 就报', (marker) => {
    const hits = findProbe(fixture({ 'app/assets/deep/b.js': `x${marker}y` }));
    expect(hits.map((h) => h.marker)).toContain(marker);
    expect(hits[0]?.file.replace(/\\/g, '/')).toBe('app/assets/deep/b.js');
  });
});

describe('接线', () => {
  it('build_web.mjs 在 production 时跑；release-build.yml 构建后另跑', () => {
    const web = readFileSync(join(root, 'build/build_web.mjs'), 'utf8');
    expect(web).toMatch(/if \(mode === 'production'\) \{\s*const probe = spawnSync\(process\.execPath, \[resolve\(ROOT, 'build\/check_no_probe\.mjs'\)/);
    expect(readFileSync(join(root, '.github/workflows/release-build.yml'), 'utf8')).toContain('node build/check_no_probe.mjs --dir dist/web');
  });

  it('探测页只经试验页懒加载，平台层探测文件只被探测页引用', () => {
    const src = join(root, 'src');
    const walk = (d: string, out: string[] = []): string[] => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|tsx)$/.test(n) && !p.includes('__tests__')) out.push(p);
      }
      return out;
    };
    const users = (needle: RegExp): string[] =>
      walk(src)
        .filter((f) => needle.test(readFileSync(f, 'utf8')))
        .map((f) => relative(root, f).replace(/\\/g, '/'))
        .sort();
    expect(users(/from '[^']*voice-probe\.ts'/)).toEqual(['src/app/dev/VoiceProbe.tsx']);
    expect(users(/VoiceProbe\.tsx'/)).toEqual(['src/app/dev/CspLab.tsx']);
    expect(readFileSync(join(src, 'app/dev/CspLab.tsx'), 'utf8')).toContain("import.meta.env.MODE === 'production' ? null : lazy(() => import('./VoiceProbe.tsx'))");
    // 试验页本身只在非正式版里挂，而且用构建期常量（正式构建整块删掉；运行时的 isProduction 删不掉）
    expect(readFileSync(join(src, 'app/App.tsx'), 'utf8')).toMatch(/const devRoutes: readonly FeatureRoute\[\] = import\.meta\.env\.MODE === 'production'\s*\?\s*\[\]/);
  });
});
