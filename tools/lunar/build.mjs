// 生成 shared/logic/anniv/lunar-data.ts（B2 BE-5、第一天派工表第 7 行）。读各来源已转好的中间格式，校验、两国逐月比对、编码、写文件。
// 用法：node tools/lunar/build.mjs           生成
//       node tools/lunar/build.mjs --check   只校验和比对、和已生成的文件核对，不写（CI：npm run check:lunar，unit.yml）；同时核对 cn-*.json 和 raw/hko 原始历表一致（raw/hko 不在也报错）
//
// 中间格式文件（JSON，见 lib.mjs 文件头）放在 tools/lunar/sources/：
//   cn-months.json  中国农历月表，由 adapters/hko-txt.mjs 从香港天文台《公历与农历日期对照表》（raw/hko/T1901c～T2100c.txt）转出。
//                   香港天文台的表从 1901-01-01 起到 2100-12-31 止：开头 1901-01-01～19 属农历 1900 年冬月还是闰冬月推不出来，不收；
//                   1900 年腊月（1901-01-20 起）收进 head；2100 年正月～冬月和只看得到初一的腊月（open）收进 tail。
//                   实际覆盖公历 1901-01-20～2100-12-31（1900 年其余日期没有官方表，按“没有农历”处理）
//   cn-terms.json   中国 24 节气，公历 1901～2100 年（香港天文台同一批表）
//   kr-months.json、kr-terms.json  韩国（KASI 음양력 자료，先只做到 2050；2051～2100 的天文推算留 B5）。【待 KASI 数据】
//                   接口已留好：将来写 adapters/kasi-*.mjs 把 KASI 原始数据转成同样的中间格式（月表、节气按东九区划日期）放到这里，
//                   本脚本就会自动做韩国结构校验和两国逐月比对（lib.mjs 的 compareCountries）。还没有数据：
//                   两个文件都缺时只生成中国部分，韩国表为空（运行时按“没有韩国农历”处理）；只缺一个算数据不全，报错
//   allow-diff.json 两国逐月比对里“本来就不同”的月份（中韩用不同经度，个别月份差一天），每条写明来源核对过；韩国数据到位后才比对
// 没有中国数据时本脚本报“数据还没收集”并退出码 2，不生成半截数据。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';
import { compareCountries, encodeMonths, encodeTerms, renderDataTs, validateMonths } from './lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'tools', 'lunar', 'sources');
export const OUT = join(ROOT, 'shared', 'logic', 'anniv', 'lunar-data.ts');
const NEED_CN = ['cn-months.json', 'cn-terms.json'];
const NEED_KR = ['kr-months.json', 'kr-terms.json'];

function load(name) {
  return JSON.parse(readFileSync(join(SRC, name), 'utf8'));
}

export function build() {
  const missing = NEED_CN.filter((n) => !existsSync(join(SRC, n)));
  if (missing.length > 0) return { ok: false, code: 2, msg: `数据还没收集：tools/lunar/sources/ 缺 ${missing.join('、')}` };
  const krHave = NEED_KR.filter((n) => existsSync(join(SRC, n)));
  if (krHave.length === 1) return { ok: false, code: 2, msg: `韩国数据不全：tools/lunar/sources/ 只有 ${krHave[0]}，${NEED_KR.find((n) => n !== krHave[0])} 还没有` };
  const hasKr = krHave.length === 2;
  const cnM = load('cn-months.json');
  const krM = hasKr ? load('kr-months.json') : null;
  const errs = validateMonths(cnM).map((e) => `中国 ${e}`);
  if (krM) {
    errs.push(...validateMonths(krM).map((e) => `韩国 ${e}`));
    const allow = existsSync(join(SRC, 'allow-diff.json')) ? load('allow-diff.json').map((x) => x.key) : [];
    for (const d of compareCountries(cnM, krM, allow)) errs.push(`两国逐月比对不一致 ${d.key}：中国 ${d.cn}，韩国 ${d.kr}（真的不同就写进 allow-diff.json 并注明核对来源）`);
  }
  if (errs.length > 0) return { ok: false, code: 1, msg: errs.join('\n') };
  let text;
  try {
    text = renderDataTs({
      cn: encodeMonths(cnM), kr: krM ? encodeMonths(krM) : null,
      termsCn: encodeTerms(load('cn-terms.json')), termsKr: hasKr ? encodeTerms(load('kr-terms.json')) : null,
      generatedFrom: hasKr ? 'tools/lunar/sources/*.json' : 'tools/lunar/sources/cn-*.json；韩国暂无数据',
    });
  } catch (e) {
    return { ok: false, code: 1, msg: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, code: 0, text, hasKr };
}

/** 核对 cn-*.json 是不是适配器从原始历表转出来的（防手改）；raw/hko 不在也算错；返回问题文字或 null */
export async function checkHkoSources(raw) {
  const { RAW, run, toJson } = await import('./adapters/hko-txt.mjs');
  const dir = raw ?? RAW;
  if (!existsSync(dir)) return `缺原始历表目录 tools/lunar/raw/hko/：cn-*.json 要能从香港天文台原始表复核，不许跳过`;
  const out = run(dir);
  const bad = [['cn-months.json', toJson(out.months)], ['cn-terms.json', toJson(out.terms)]]
    .filter(([n, t]) => readFileSync(join(SRC, n), 'utf8') !== t).map(([n]) => n);
  return bad.length > 0 ? `tools/lunar/sources/ 下 ${bad.join('、')} 和香港天文台原始历表不一致：跑 node tools/lunar/adapters/hko-txt.mjs 重新生成` : null;
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  const r = build();
  if (!r.ok) {
    stderr.write(`${r.msg}\n`);
    exit(r.code);
  }
  if (argv.includes('--check')) {
    const srcErr = await checkHkoSources().catch((e) => (e instanceof Error ? e.message : String(e)));
    if (srcErr) {
      stderr.write(`${srcErr}\n`);
      exit(1);
    }
    const have = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
    if (have !== r.text) {
      stderr.write('shared/logic/anniv/lunar-data.ts 和 tools/lunar/sources 不一致：跑 node tools/lunar/build.mjs 重新生成\n');
      exit(1);
    }
    stdout.write(`lunar-data.ts 和来源一致；中国：sources 和香港天文台原始历表一致${r.hasKr ? '；韩国：结构校验和两国逐月比对通过' : '；韩国：待 KASI 数据，两国逐月比对跳过'}\n`);
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, r.text, 'utf8');
    stdout.write(`已生成 ${OUT}${r.hasKr ? '' : '（只有中国数据，韩国部分为空）'}\n`);
  }
}
