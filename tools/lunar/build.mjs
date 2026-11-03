// 生成 shared/logic/anniv/lunar-data.ts（B2 BE-5、第一天派工表第 7 行）。骨架：读各来源已转好的中间格式，校验、两国逐月比对、编码、写文件。
// 用法：node tools/lunar/build.mjs           生成
//       node tools/lunar/build.mjs --check   只校验和比对、和已生成的文件核对，不写（CI 用）
//
// 中间格式文件（JSON，见 lib.mjs 文件头）放在 tools/lunar/sources/：
//   cn-months.json  中国 1900～2100 的农历月表（香港天文台“公历与农历日期对照表”逐年换算）
//   kr-months.json  韩国 1900～2050 的农历月表（KASI 음양력 자료；2051～2100 的天文推算留 B5）
//   cn-terms.json、kr-terms.json  两国 24 节气（香港天文台、KASI）
//   allow-diff.json 两国逐月比对里“本来就不同”的月份（中韩用不同经度，个别月份差一天），每条写明来源核对过
// 把原始历表转成中间格式的适配器（tools/lunar/adapters/）要等原始文件取到以后按实际格式写：取数据要联网下载、KASI 接口要申请 serviceKey，
// 都要负责人定（见 B2 后端回报）。没有中间格式文件时本脚本报“数据还没收集”并退出码 2，不生成半截数据。
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { compareCountries, encodeMonths, encodeTerms, renderDataTs, validateMonths } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'tools', 'lunar', 'sources');
export const OUT = join(ROOT, 'shared', 'logic', 'anniv', 'lunar-data.ts');
const NEED = ['cn-months.json', 'kr-months.json', 'cn-terms.json', 'kr-terms.json'];

function load(name) {
  return JSON.parse(readFileSync(join(SRC, name), 'utf8'));
}

export function build() {
  const missing = NEED.filter((n) => !existsSync(join(SRC, n)));
  if (missing.length > 0) return { ok: false, code: 2, msg: `数据还没收集：tools/lunar/sources/ 缺 ${missing.join('、')}` };
  const cnM = load('cn-months.json');
  const krM = load('kr-months.json');
  const allow = existsSync(join(SRC, 'allow-diff.json')) ? load('allow-diff.json').map((x) => x.key) : [];
  const errs = [...validateMonths(cnM).map((e) => `中国 ${e}`), ...validateMonths(krM).map((e) => `韩国 ${e}`)];
  const diffs = compareCountries(cnM, krM, allow);
  for (const d of diffs) errs.push(`两国逐月比对不一致 ${d.key}：中国 ${d.cn}，韩国 ${d.kr}（真的不同就写进 allow-diff.json 并注明核对来源）`);
  if (errs.length > 0) return { ok: false, code: 1, msg: errs.join('\n') };
  const text = renderDataTs({
    cn: encodeMonths(cnM), kr: encodeMonths(krM), termsCn: encodeTerms(load('cn-terms.json')), termsKr: encodeTerms(load('kr-terms.json')),
    generatedFrom: 'tools/lunar/sources/*.json',
  });
  return { ok: true, code: 0, text };
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  const r = build();
  if (!r.ok) {
    stderr.write(`${r.msg}\n`);
    exit(r.code);
  }
  if (argv.includes('--check')) {
    const have = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (have !== r.text) {
      stderr.write('shared/logic/anniv/lunar-data.ts 和 tools/lunar/sources 不一致：跑 node tools/lunar/build.mjs 重新生成\n');
      exit(1);
    }
    stdout.write('lunar-data.ts 和来源一致\n');
  } else {
    writeFileSync(OUT, r.text, 'utf8');
    stdout.write(`已生成 ${OUT}\n`);
  }
}
