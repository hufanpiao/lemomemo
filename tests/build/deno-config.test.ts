// deno.json 里钉的版本必须和 package.json 一样（架构 2.5：shared 前后端共用，版本不一致会两边校验结果不同）
// supabase/functions/ 和 build/ 里写全的 npm:包@版本 也要和 package.json 一样（deno.json 的 nodeModulesDir=manual 用的是 node_modules 里那一份）
// 进程时区也核对一下：test:tz 设的 TZ 真的生效了
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..');
const readJson = (f: string): unknown => JSON.parse(readFileSync(join(root, f), 'utf8'));
const pkg = readJson('package.json') as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
const deps: Record<string, string> = { ...pkg.dependencies, ...pkg.devDependencies };

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name === 'gen') continue;
    if (statSync(p).isDirectory()) tsFiles(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('deno.json', () => {
  const deno = readJson('deno.json') as { imports: Record<string, string>; tasks: Record<string, string> };

  it('映射的 npm 包版本都和 package.json 一致', () => {
    for (const name of ['zod', 'postgres', '@supabase/supabase-js']) {
      expect(deno.imports[name], name).toBe(`npm:${name}@${deps[name]}`);
    }
  });

  it('CI 用到的任务都在：test（ci.yml 的 deno task test）、check、d1', () => {
    expect(Object.keys(deno.tasks).sort()).toEqual(['check', 'd1', 'test']);
    expect(deno.tasks.check).toContain('supabase/functions/_shared/');
  });

  it('supabase/functions、build 里写全的 npm:包@版本 和 package.json 一致', () => {
    const files = [...tsFiles(join(root, 'supabase', 'functions')), ...tsFiles(join(root, 'build'))];
    const seen: string[] = [];
    for (const f of files) {
      for (const m of readFileSync(f, 'utf8').matchAll(/['"]npm:((?:@[^/'"]+\/)?[^@'"]+)@([^'"/]+)/g)) {
        const [, name = '', ver] = m;
        seen.push(`${relative(root, f)} ${name}`);
        expect(ver, `${relative(root, f)}：${name}`).toBe(deps[name]);
      }
    }
    expect(seen.length).toBeGreaterThan(0);
  });

  it('进程时区和 TZ 环境变量一致（test:tz 用）', () => {
    const want = process.env.TZ;
    if (want) expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(want === 'UTC' ? 'UTC' : want);
  });
});
