// 往 S3 替身（运维 O-1 的容器；本机和 CI）里放测试对象（任务单 BE-5）：A、B 在四个 R2 桶里各几份，清单见 tests/fakes/objstore-seed.ts
// 用法（仓库根目录，替身已起、四个桶已建）：
//   R2_ENDPOINT=http://127.0.0.1:<替身端口> R2_BUCKET_PREFIX= OBJSTORE_TEST_KEY_ID=<替身的> OBJSTORE_TEST_SECRET=<替身的> \
//     node supabase/tests/objstore/seed.mjs [--check]
//   --check：不写，只按前缀数每个桶里 A、B 各有几个对象（注销用例前后对比用，TC-B0-117）
// 走真的 shared/objstore.ts（前端 B 的 FB-1），和服务器函数同一份 S3 客户端；它还没合进来时直接退出（退出码 2，“待前端 B”）
// 只连本机替身：R2_ENDPOINT 不是 127.0.0.1 / localhost 就拒绝，防止把测试数据写进预览或正式的 R2
// 令牌只从环境变量读，不打印、不写文件；变量名故意不用 R2_FN_*（那是九个规定函数专用的，TC-B0-75 的 CI grep 查它）。需要 Docker（替身容器）：待 Docker
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { R2_BUCKETS, SEED_USERS, seedObjects } from '../../../tests/fakes/objstore-seed.ts';

const root = resolve(import.meta.dirname, '..', '..', '..');
const check = process.argv.includes('--check');

const endpoint = process.env.R2_ENDPOINT ?? '';
const host = (() => { try { return new URL(endpoint).hostname; } catch { return ''; } })();
if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
  console.error('seed：R2_ENDPOINT 必须是本机替身（127.0.0.1 / localhost），不往真 R2 写测试数据');
  process.exit(1);
}
const keyId = process.env.OBJSTORE_TEST_KEY_ID, secret = process.env.OBJSTORE_TEST_SECRET;
if (!keyId || !secret) {
  console.error('seed：缺 OBJSTORE_TEST_KEY_ID 或 OBJSTORE_TEST_SECRET（替身的，不是真令牌）');
  process.exit(1);
}

const modPath = join(root, 'shared', 'objstore.ts');
if (!existsSync(modPath)) {
  console.error('seed：shared/objstore.ts 还没有（前端 B 的 FB-1），待前端 B');
  process.exit(2);
}
// 约定（待前端 B 定稿时对一遍）：shared/objstore.ts 导出 createObjStore({ endpoint, accessKeyId, secretAccessKey, bucketPrefix })，
//   返回值的方法和 tests/fakes/objstore-memory.ts 的 ObjStore 接口一致
const mod = await import(pathToFileURL(modPath).href);
if (typeof mod.createObjStore !== 'function') {
  console.error('seed：shared/objstore.ts 没导出 createObjStore，按前端 B 的实际导出改这里');
  process.exit(2);
}
const store = mod.createObjStore({ endpoint, accessKeyId: keyId, secretAccessKey: secret, bucketPrefix: process.env.R2_BUCKET_PREFIX ?? '' });

if (check) {
  for (const b of R2_BUCKETS) {
    const counts = {};
    for (const [who, uid] of Object.entries(SEED_USERS)) {
      let n = 0, token = null;
      do {
        const page = await store.list(b, `${uid}/`, { token });
        n += page.items.length;
        token = page.nextToken;
      } while (token);
      counts[who] = n;
    }
    console.log(`${b}：A ${counts.a} 个，B ${counts.b} 个`);
  }
} else {
  let put = 0, existed = 0;
  for (const o of seedObjects()) {
    const r = await store.put(o.bucket, o.key, o.body, { contentType: o.contentType, ifNoneMatch: '*' });
    if (r.ok) put++; else existed++;
  }
  console.log(`seed：写入 ${put} 个，已存在 ${existed} 个（条件写，不覆盖）`);
}
