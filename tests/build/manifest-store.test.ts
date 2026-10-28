// 架构 0.32（R-213）：清单 buckets[] 的 store 必填（BE-3，TC-B0-118 第一份样例）
import { describe, expect, it } from 'vitest';
import { defineManifest } from '../../shared/schema/manifest.ts';
import { allManifests } from '../../shared/manifests/index.ts';
import { CLIENT_FILE_BUCKETS } from '../../shared/manifests/_common.ts';

const bucket = { name: 'qa', pathPrefix: '<user_id>/', pathPattern: '^x$', backup: 'none', export: 'none', countsToQuota: false,
  orphanSweep: null, noUserData: true } as const;

describe('清单的 store（0.32）', () => {
  it('不写 store：zod 加载时报错，报错里有 store', () => {
    // @ts-expect-error 故意漏写 store（类型上也过不去，typecheck 同样拦）
    expect(() => defineManifest({ feature: 'qa', owner: 'feature', tables: [], buckets: [bucket] })).toThrow(/store/);
  });

  it('store 只能是 supabase 或 r2', () => {
    // @ts-expect-error 故意写错值
    expect(() => defineManifest({ feature: 'qa', owner: 'feature', tables: [], buckets: [{ ...bucket, store: 's3' }] })).toThrow(/store/);
    expect(defineManifest({ feature: 'qa', owner: 'feature', tables: [], buckets: [{ ...bucket, store: 'r2' }] }).buckets[0]?.store).toBe('r2');
  });

  it('6 个桶：images、files、vault-images、vault-files 是 r2，backups、vault-preview 是 supabase（R-213）；同名桶各段一致', () => {
    const got: Record<string, string[]> = {};
    for (const b of allManifests.flatMap((m) => m.buckets)) (got[b.name] ??= []).push(b.store);
    expect(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, [...new Set(v)]]))).toEqual({
      images: ['r2'], files: ['r2'], 'vault-images': ['r2'], 'vault-files': ['r2'], backups: ['supabase'], 'vault-preview': ['supabase'],
    });
  });

  it('客户端可传的桶只有 images、files，都在 R2', () => {
    expect([...CLIENT_FILE_BUCKETS]).toEqual(['images', 'files']);
  });
});
