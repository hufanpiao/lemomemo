// 往 S3 替身（运维 O-1 的容器；本机和 CI）里放测试对象（任务单 BE-5）：A、B 在四个 R2 桶里各几份，清单见 tests/fakes/objstore-seed.ts
// 用法（仓库根目录，替身已起、四个桶已建）：
//   R2_ENDPOINT=http://127.0.0.1:<替身端口> R2_BUCKET_PREFIX= OBJSTORE_TEST_KEY_ID=<替身的> OBJSTORE_TEST_SECRET=<替身的> \
//     node supabase/tests/objstore/seed.mjs [--check]
//   --check：不写，只按前缀数每个桶里 A、B 各有几个对象（注销用例前后对比用，TC-B0-117）
// 走真的 shared/objstore.ts（前端 B 的 FB-1 定稿版），和服务器函数同一份 S3 客户端；写入和计数用 tests/fakes/objstore-seed.ts 的
//   putSeedObjects、countSeedUsers（按 ObjStore 接口写，内存替身的单测也用同一份）
// 只连本机替身：R2_ENDPOINT 不是 127.0.0.1 / localhost 就拒绝，防止把测试数据写进预览或正式的 R2
// 令牌只从环境变量读，不打印、不写文件；变量名故意不用 R2_FN_*（那是九个规定函数专用的，TC-B0-75 的 CI grep 查它）。需要 Docker（替身容器）：待 Docker
import { createObjStore } from '../../../shared/objstore.ts';
import { countSeedUsers, putSeedObjects, R2_BUCKETS } from '../../../tests/fakes/objstore-seed.ts';

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

const store = createObjStore({
  endpoint,
  accessKeyId: keyId,
  secretAccessKey: secret,
  bucketPrefix: process.env.R2_BUCKET_PREFIX ?? '',
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
});

if (check) {
  const counts = await countSeedUsers(store);
  for (const b of R2_BUCKETS) console.log(`${b}：A ${counts[b].a} 个，B ${counts[b].b} 个`);
} else {
  const { put, existed } = await putSeedObjects(store);
  console.log(`seed：写入 ${put} 个，已存在 ${existed} 个（条件写，不覆盖）`);
}
