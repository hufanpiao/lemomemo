// build/gen_files_rules.mjs：/files 的规则表必须由清单生成、和仓库里的逐字一致（架构 3.5 第 2 点、0.32 第 9 条；任务单 FB-2）
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildRules, OUT, render, renderFilesRules } from '../../build/gen_files_rules.mjs';
import { allManifests } from '../../shared/manifests/index.ts';

type Manifest = (typeof allManifests)[number];
type Bucket = NonNullable<Manifest['buckets']>[number];

const gen = renderFilesRules as (m: readonly unknown[]) => string;
const build = buildRules as (m: readonly unknown[]) => { bucket: string; segment: string; pathPattern: string }[];

/** 深拷贝清单后改一个桶 */
function tweak(fn: (b: Bucket & Record<string, unknown>) => void, name: string, prefix?: string): unknown[] {
  const copy = JSON.parse(JSON.stringify(allManifests)) as Manifest[];
  for (const m of copy) for (const b of m.buckets ?? []) if (b.name === name && (prefix === undefined || b.pathPrefix === prefix)) fn(b as Bucket & Record<string, unknown>);
  return copy;
}

describe('gen_files_rules', () => {
  it('重新生成的和仓库里的 functions/_generated/files-rules.ts 逐字一致（CI 防手改）', () => {
    const cur = readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n');
    expect(gen(allManifests)).toBe(cur);
  });

  it('前 5 行里有“自动生成，不要手改”；renderFilesRules 等于 render(buildRules())', () => {
    const out = gen(allManifests);
    expect(out.split('\n').slice(0, 5).join('\n')).toContain('自动生成，不要手改');
    expect(out).toBe((render as (r: unknown) => string)(build(allManifests)));
  });

  it('pathPattern 照抄清单（D1 拿它和 files_authorize_impl 比）', () => {
    const fromManifest = allManifests.flatMap((m) => m.buckets ?? []).filter((b) => b.name === 'images' || b.name === 'files');
    const rules = build(allManifests);
    expect(rules.map((r) => r.pathPattern).sort()).toEqual(fromManifest.map((b) => b.pathPattern).sort());
  });

  it('改了清单的正则，生成结果就和仓库里的不一致', () => {
    const changed = tweak((b) => {
      b.pathPattern = b.pathPattern.replace('[0-9a-f-]{36}', '[0-9a-z-]{36}');
    }, 'images', '<user_id>/');
    expect(gen(changed)).not.toBe(readFileSync(OUT, 'utf8').replace(/\r\n/g, '\n'));
  });

  it("客户端可传的桶不是 store = 'r2' 就失败", () => {
    const changed = tweak((b) => {
      b.store = 'supabase';
    }, 'files');
    expect(() => gen(changed)).toThrow(/store = 'r2'/);
  });

  it('附件扩展名和 DOC_EXT_MIME 对不上就失败', () => {
    const changed = tweak((b) => {
      b.pathPattern = b.pathPattern.replace('|ppt)', '|ppt|exe)');
    }, 'files');
    expect(() => gen(changed)).toThrow(/DOC_EXT_MIME/);
  });

  it('images 桶放了 webp 以外的类型就失败', () => {
    const changed = tweak((b) => {
      if (b.limits) b.limits.allowedMimeTypes = ['image/webp', 'image/png'];
    }, 'images');
    expect(() => gen(changed)).toThrow(/image\/webp/);
  });

  it('多出一段生成器不认识的路径就失败', () => {
    const changed = tweak((b) => {
      b.pathPrefix = '<user_id>/other/';
    }, 'images', '<user_id>/anniv/');
    expect(() => gen(changed)).toThrow(/不认识/);
  });
});
