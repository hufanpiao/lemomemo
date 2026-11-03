// 由 tests/fixtures/push-endpoints.json 生成 supabase/tests/rls/29_push_endpoint_vectors.test.sql（B2 TC-B2-80 的 SQL 一侧；安全审查 D1-3）。
// pgTAP 读不了文件，所以把 fixture 里的每一条转成一句断言；Deno / Node 一侧（tests/shared/push/push-endpoint.test.ts）直接 import 同一个 JSON。
// 字符串一律按 UTF-8 转成 base64 再嵌进 SQL（convert_from(decode(…))），不手工转义引号、反斜杠、控制字符。
// "pg": false 的条目（含 \u0000，PostgreSQL 的 text 放不下）跳过，文件里写明跳过了几条。
// 用法：node build/gen_push_vectors.mjs          重新生成
//       node build/gen_push_vectors.mjs --check  只核对，不一致就退出码 1（tests/build/push-vectors-sync.test.ts 也会核对）
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE = join(ROOT, 'tests', 'fixtures', 'push-endpoints.json');
export const OUT = join(ROOT, 'supabase', 'tests', 'rls', '29_push_endpoint_vectors.test.sql');

/** 测 p256dh 时配的 auth、测 auth 时配的 p256dh（两条都合格） */
const GOOD_AUTH = 'A'.repeat(22);
const GOOD_P256DH = 'BA' + 'A'.repeat(85);

const lit = (s) => `convert_from(decode('${Buffer.from(s, 'utf8').toString('base64')}', 'base64'), 'UTF8')`;
const desc = (s) => `'${s.replace(/[^\p{L}\p{N} _.,:;()（）、，：；／/+=-]/gu, ' ').replace(/'/g, "''").slice(0, 120)}'`;

export function render(fx) {
  const eps = fx.endpoints.filter((e) => e.pg !== false);
  const skipped = fx.endpoints.length - eps.length;
  const lines = [
    '-- 自动生成，不要手改：node build/gen_push_vectors.mjs（来源 tests/fixtures/push-endpoints.json，由测试开发维护）',
    '-- TC-B2-80 的 SQL 一侧：private.push_endpoint_ok、private.push_keys_ok 逐条对 fixture 的 ok（迁移 20261103110000_core_claim_endpoint.sql）。',
    `-- 端点 ${fx.endpoints.length} 条（跳过 "pg": false 的 ${skipped} 条），密钥 ${fx.keys.length} 条，只在发送时拒的公钥（keysSendOnly）${(fx.keysSendOnly ?? []).length} 条。Deno / Node 一侧是 tests/shared/push/push-endpoint.test.ts`,
    'begin;',
    `select plan(${eps.length + fx.keys.length + (fx.keysSendOnly ?? []).length});`,
    '',
  ];
  for (const e of eps) {
    lines.push(`select is(private.push_endpoint_ok(${lit(e.endpoint)}), ${e.ok}, ${desc(`${e.id} ${e.why}`)});`);
  }
  lines.push('');
  for (const k of fx.keys) {
    const call = k.field === 'p256dh' ? `private.push_keys_ok(${lit(k.value)}, '${GOOD_AUTH}')` : `private.push_keys_ok('${GOOD_P256DH}', ${lit(k.value)})`;
    lines.push(`select is(${call}, ${k.ok}, ${desc(`${k.id} ${k.field} ${k.why}`)});`);
  }
  lines.push('');
  // 点不在曲线上：SQL 照收（sqlOk），发送时才 bad_keys（安全审查 1.5 D1-7，唯一允许两边不一致的一组；发送一侧在 tests/edge/push-send.test.ts）
  for (const k of fx.keysSendOnly ?? []) {
    lines.push(`select is(private.push_keys_ok(${lit(k.value)}, '${GOOD_AUTH}'), ${k.sqlOk}, ${desc(`${k.id} ${k.field} 只在发送时拒`)});`);
  }
  lines.push('', 'select * from finish();', 'rollback;', '');
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const want = render(JSON.parse(readFileSync(FIXTURE, 'utf8')));
  if (process.argv.includes('--check')) {
    let have = '';
    try { have = readFileSync(OUT, 'utf8'); } catch { /* 没有文件就算不一致 */ }
    if (have !== want) {
      console.error('29_push_endpoint_vectors.test.sql 和 fixture 不一致：跑 node build/gen_push_vectors.mjs 重新生成');
      process.exit(1);
    }
    console.log('29_push_endpoint_vectors.test.sql 和 fixture 一致');
  } else {
    writeFileSync(OUT, want, 'utf8');
    console.log(`已生成 ${OUT}`);
  }
}
