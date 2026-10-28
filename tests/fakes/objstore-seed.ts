// 对象存储的测试数据（任务单 BE-5）：A、B 两个用户在四个 R2 桶里各几份对象，路径照清单的 pathPattern 拼
// 用在两处：内存替身（tests/fakes/objstore-memory.ts）的单测和生成用例；S3 替身容器的 seed 脚本（supabase/tests/objstore/seed.mjs）
// 用户 id 和 supabase/tests/rls/_helpers.psql 的 tests.seed() 一致（A、B），数据库那一侧造行时可以直接对上
// 写入和计数走 shared/objstore.ts 的 ObjStore 接口（真客户端和内存替身都 implements 它）
// 纯 TS，不用 Node、Deno 的 API
import { type ObjStore, ObjStoreError } from '../../shared/objstore.ts';

export const SEED_USERS = {
  a: 'aaaaaaaa-0000-4000-8000-000000000001',
  b: 'bbbbbbbb-0000-4000-8000-000000000002',
} as const;

/** 四个 R2 桶（清单 store = 'r2'；替身启动脚本建的就是这四个，预览环境另加 R2_BUCKET_PREFIX） */
export const R2_BUCKETS = ['images', 'files', 'vault-images', 'vault-files'] as const;
export type R2Bucket = (typeof R2_BUCKETS)[number];

export type SeedObject = { bucket: R2Bucket; key: string; contentType: string; body: Uint8Array; owner: keyof typeof SEED_USERS };

const enc = new TextEncoder();
/** 最小的 webp 文件头（RIFF????WEBP），/files 的文件头检查认它 */
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x0c, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c]);
const PDF = enc.encode('%PDF-1.7\n%seed\n');
const CIPHER = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);   // 隐私记附件是密文

/** 第 n 号 id：同一个前缀，最后一段按 owner 和序号区分（和 tests.seed 的写法一样，十六进制小写） */
const id = (prefix: string, owner: 'a' | 'b', n: number) => `${prefix}-0000-4000-8000-0000000000${owner}${n}`;

export function seedObjects(): SeedObject[] {
  const out: SeedObject[] = [];
  for (const owner of ['a', 'b'] as const) {
    const u = SEED_USERS[owner];
    const note = id('40000000', owner, 1);
    const img = id('1e000000', owner, 1), img2 = id('1e000000', owner, 2);
    const anniv = id('a0000000', owner, 1), avatar = id('0a000000', owner, 1);
    const file = id('f0000000', owner, 1), vfile = id('f0000000', owner, 2);
    out.push(
      { bucket: 'images', key: `${u}/${note}/${img}.webp`, contentType: 'image/webp', body: WEBP, owner },
      { bucket: 'images', key: `${u}/${note}/${img}.t.webp`, contentType: 'image/webp', body: WEBP, owner },
      { bucket: 'images', key: `${u}/anniv/${anniv}/${avatar}.webp`, contentType: 'image/webp', body: WEBP, owner },
      { bucket: 'files', key: `${u}/${note}/${file}.pdf`, contentType: 'application/pdf', body: PDF, owner },
      { bucket: 'files', key: `${u}/${note}/${file}.t.webp`, contentType: 'image/webp', body: WEBP, owner },
      { bucket: 'vault-images', key: `${u}/${note}/${img2}.webp`, contentType: 'image/webp', body: WEBP, owner },
      { bucket: 'vault-files', key: `${u}/${note}/${vfile}.pdf`, contentType: 'application/octet-stream', body: CIPHER, owner },
    );
  }
  return out;
}

/** 条件写（ifNoneMatch: true）放进全部测试对象；已在的不覆盖，记成 existed（重复跑 seed 不报错） */
export async function putSeedObjects(store: Pick<ObjStore, 'put'>, objects: readonly SeedObject[] = seedObjects()): Promise<{ put: number; existed: number }> {
  let put = 0, existed = 0;
  for (const o of objects) {
    try {
      await store.put(o.bucket, o.key, o.body, { contentType: o.contentType, ifNoneMatch: true });
      put++;
    } catch (e) {
      if (e instanceof ObjStoreError && e.code === 'exists') existed++;
      else throw e;
    }
  }
  return { put, existed };
}

/** 每个桶里 A、B 各有几个对象（按 <user_id>/ 前缀列全；注销前后对比用，TC-B0-117） */
export async function countSeedUsers(store: Pick<ObjStore, 'listAll'>): Promise<Record<R2Bucket, Record<keyof typeof SEED_USERS, number>>> {
  const out = {} as Record<R2Bucket, Record<keyof typeof SEED_USERS, number>>;
  for (const b of R2_BUCKETS) {
    out[b] = { a: (await store.listAll(b, `${SEED_USERS.a}/`)).length, b: (await store.listAll(b, `${SEED_USERS.b}/`)).length };
  }
  return out;
}
