// FA-6 ③：网页构建里裸的 'zod' 一律别名到 src/platform/zod-jitless.ts（先关 JIT 再转出），zod 才能移出首屏而不用在入口第一个 import 它。
// 守三件事：vite.config.ts 真的挂着这个别名、只匹配整个 'zod'；垫片导入后 JIT 已关；src、shared 里没有别的文件绕过别名直接引 zod 的子路径
// （SW 不引 zod，vite.sw.config.ts 不需要别名）
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const SHIM = 'src/platform/zod-jitless.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(name)) out.push(p);
  }
  return out;
}

describe('zod 的 JIT 由别名统一关掉', () => {
  it('vite.config.ts 的 resolve.alias 挂着 ZOD_JITLESS_ALIAS，指向垫片', async () => {
    const mod = await import('../../vite.config.ts');
    const cfg = (mod.default as (e: object) => { resolve?: { alias?: unknown[] } })({ mode: 'e2e', command: 'build' });
    expect(cfg.resolve?.alias).toContain(mod.ZOD_JITLESS_ALIAS);
    expect(resolve(mod.ZOD_JITLESS_ALIAS.replacement)).toBe(resolve(root, SHIM));
    expect(existsSync(mod.ZOD_JITLESS_ALIAS.replacement)).toBe(true);
  });

  it('只匹配整个说明符 zod：垫片自己引的 zod/v4 和别的子路径不会被改回垫片', async () => {
    const { ZOD_JITLESS_ALIAS: a } = await import('../../vite.config.ts');
    expect(a.find.test('zod')).toBe(true);
    for (const s of ['zod/v4', 'zod/mini', 'zod/v4/core', 'zodiac', '@x/zod']) expect(a.find.test(s), s).toBe(false);
  });

  it('垫片导入后 JIT 已关（z.config() 读回 jitless: true），转出的 z 和 zod 本身是同一份', async () => {
    const shim = await import('../../src/platform/zod-jitless.ts');
    const real = await import('zod');
    expect(shim.z.config().jitless).toBe(true);
    expect(shim.z).toBe(real.z);
    expect(shim.default).toBe(real.z);
    expect(shim.object).toBe(real.object);
  });

  it('src、shared 里除垫片外没有文件直接引 zod 的子路径（那样会绕过别名、拿到没关 JIT 的入口）', () => {
    const bad: string[] = [];
    for (const f of [...walk(join(root, 'src')), ...walk(join(root, 'shared'))]) {
      const rel = relative(root, f).replaceAll('\\', '/');
      if (rel === SHIM) continue;
      if (/from\s+['"]zod\/|import\(\s*['"]zod\/|^\s*import\s+['"]zod\//m.test(readFileSync(f, 'utf8'))) bad.push(rel);
    }
    expect(bad).toEqual([]);
  });
});
