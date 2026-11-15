// 生成 shared/logic/anniv/lunar-huangli-data.ts（R-431 黄历卡的每日宜忌表）。
// 用法：node tools/huangli/build.mjs           生成
//       node tools/huangli/build.mjs --check   只核对、不写（CI：npm run check:huangli，unit.yml）：
//         ① 已生成的文件和用开发依赖 lunar-javascript 重新生成的一字不差；
//         ② 运行时 lunar-huangli.ts 查表的结果和 lunar-javascript 逐日一致（公历 1901-01-20～2100-12-31），
//            只许 ALLOW_DIFF 里写明原因的日子不同
//
// 为什么自己生成一张表、不把库打进 App（R-431 评估，11-15）：
// • 库只在这里用（开发依赖），App 只带这张表（gzip 约 10 KB）；整库打进去 gzip 72～100 KB，按需引用也拆不小
// • lunar-javascript 的每日宜忌（LunarUtil.getDayYi / getDayJi，默认口径 sect 1）只由两样决定：节气月的月支（交节当天算新月）和日干支。
//   月干不影响结果（本脚本生成时逐格核对，60 个月干支 × 60 个日干支，同月支不同月干结果不同就报错）。
//   所以表只有 12 × 60 = 720 格；运行时月支按我们自己的 TERMS_CN（香港天文台）定、日干支按天数算，和月历显示的节气同一份数据，
//   节气交界日不会出现“月历写立冬、黄历还按上个月”
// • 显示口径（主持人 11-15 定）：“馀”写成“余”（生成时换）；“无”不进表，那一行是空数组，界面写“—”；“诸事不宜”照原文
//
// 表的编码：HUANGLI_WORDS 是词表（只收用到的词，按库里 YI_JI 的先后）；HUANGLI_DAYS 第 (月支序号 × 60 + 日干支序号) 格是“宜|忌”，
// 每个词写成两位 36 进制的词表序号。月支序号 子 0 … 亥 11，日干支序号 甲子 0 … 癸亥 59
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const OUT = join(ROOT, 'shared', 'logic', 'anniv', 'lunar-huangli-data.ts');
const PKG = 'lunar-javascript';

/**
 * 库的节气算法和香港天文台交节日差一天、所以宜忌跟着不同的日子（--check 逐日比对时放过）。
 * 11-15 逐日比对 1901～2100 只有这两天：库按自己的天文算法，我们按香港天文台历表；App 显示一律以香港天文台为准
 */
export const ALLOW_DIFF = {
  '1917-12-07': '大雪：香港天文台 12-07、库 12-08（我们按子月、库按亥月）',
  '1927-09-08': '白露：香港天文台 09-08、库 09-09（我们按酉月、库按申月）',
};

const ZHI = '子丑寅卯辰巳午未申酉戌亥';

function loadLib() {
  const req = createRequire(join(ROOT, 'package.json'));
  const lib = req(PKG);
  const version = JSON.parse(readFileSync(req.resolve(`${PKG}/package.json`), 'utf8')).version;
  return { lib, version };
}

/** 显示口径：去掉“无”，“馀”换成“余” */
export const normWords = (ws) => ws.filter((w) => w !== '无').map((w) => w.replaceAll('馀', '余'));

const code = (i) => i.toString(36).padStart(2, '0');

export function build() {
  let loaded;
  try {
    loaded = loadLib();
  } catch {
    return { ok: false, code: 2, msg: `找不到开发依赖 ${PKG}：先 npm ci` };
  }
  const { lib, version } = loaded;
  const U = lib.LunarUtil;
  const jz = U.JIA_ZI;
  if (!Array.isArray(jz) || jz.length !== 60) return { ok: false, code: 1, msg: `${PKG} 的 JIA_ZI 不是 60 项，库的内部结构变了` };
  /** 每格 [宜[], 忌[]]（已按显示口径），月支 0～11 × 日干支 0～59 */
  const cells = [];
  for (let z = 0; z < 12; z++) {
    const months = jz.filter((g) => g.slice(1) === ZHI.charAt(z));
    for (const d of jz) {
      const vals = months.map((m) => JSON.stringify([normWords(U.getDayYi(m, d)), normWords(U.getDayJi(m, d))]));
      if (new Set(vals).size !== 1) return { ok: false, code: 1, msg: `${ZHI.charAt(z)}月 ${d}日：月干不同宜忌也不同，表只按月支查不够了（${PKG} ${version} 改了算法）` };
      cells.push(JSON.parse(vals[0]));
    }
  }
  const used = new Set(cells.flat(2));
  const words = normWords(U.YI_JI).filter((w, i, a) => used.has(w) && a.indexOf(w) === i);
  const missing = [...used].filter((w) => !words.includes(w));
  if (missing.length > 0) return { ok: false, code: 1, msg: `宜忌里有词表外的词：${missing.join('、')}` };
  if (words.length > 36 * 36) return { ok: false, code: 1, msg: '词表超过两位 36 进制能编的数量' };
  const enc = (ws) => ws.map((w) => code(words.indexOf(w))).join('');
  const days = cells.map(([yi, ji]) => `${enc(yi)}|${enc(ji)}`);
  const text = `// 自动生成，不要手改：node tools/huangli/build.mjs（来源：开发依赖 ${PKG} ${version} 的 LunarUtil 每日宜忌，MIT，Copyright (c) 2018 6tail）
// R-431 黄历卡。编码见 tools/huangli/build.mjs 文件头：HUANGLI_DAYS 第 (月支序号 × 60 + 日干支序号) 格是“宜|忌”，每个词两位 36 进制的 HUANGLI_WORDS 序号；
// 空的一边 = 库写“无”。显示口径“馀”已换成“余”。查表用 shared/logic/anniv/lunar-huangli.ts；本文件只在日历页、中文界面按需加载（架构 2.6）
export const HUANGLI_WORDS: readonly string[] = ${JSON.stringify(words)};
export const HUANGLI_DAYS: readonly string[] = ${JSON.stringify(days)};
`;
  return { ok: true, code: 0, text, cells, words, version, lib };
}

/** 运行时查表（lunar-huangli.ts）和库逐日比对；返回不一致的日子（ALLOW_DIFF 之外的） */
export async function crossCheck(lib) {
  const url = (p) => pathToFileURL(join(ROOT, p)).href;
  const { huangliOf } = await import(url('shared/logic/anniv/lunar-huangli.ts'));
  const bad = [];
  let n = 0;
  for (let t = Date.UTC(1901, 0, 20); t <= Date.UTC(2100, 11, 31); t += 86_400_000) {
    const dt = new Date(t);
    const y = dt.getUTCFullYear();
    const m = dt.getUTCMonth() + 1;
    const d = dt.getUTCDate();
    const ds = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const l = lib.Solar.fromYmd(y, m, d).getLunar();
    const want = JSON.stringify([normWords(l.getDayYi()), normWords(l.getDayJi())]);
    const h = huangliOf(ds);
    const got = h === null ? 'null' : JSON.stringify([h.yi, h.ji]);
    n++;
    const allowed = Object.hasOwn(ALLOW_DIFF, ds);
    if (got !== want && !allowed) bad.push(`${ds}：运行时 ${got}，库 ${want}`);
    // 放过的日子其实一致了（库或香港天文台数据改了）：名单过时，也报
    if (got === want && allowed) bad.push(`${ds}：ALLOW_DIFF 里有，但现在一致了，从名单里删掉`);
  }
  return { n, bad };
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
      stderr.write(`shared/logic/anniv/lunar-huangli-data.ts 和 ${PKG} ${r.version} 生成的不一致：跑 node tools/huangli/build.mjs 重新生成\n`);
      exit(1);
    }
    const { n, bad } = await crossCheck(r.lib);
    if (bad.length > 0) {
      stderr.write(`运行时宜忌和 ${PKG} 逐日比对有 ${bad.length} 天不一致（真的该不同就写进 ALLOW_DIFF 并注明原因）：\n${bad.slice(0, 20).join('\n')}\n`);
      exit(1);
    }
    stdout.write(`lunar-huangli-data.ts 和 ${PKG} ${r.version} 一致；运行时查表和库逐日比对 ${n} 天，除 ALLOW_DIFF 的 ${Object.keys(ALLOW_DIFF).length} 天外全部一致\n`);
  } else {
    writeFileSync(OUT, r.text, 'utf8');
    stdout.write(`已生成 ${OUT}（${r.words.length} 个词，${r.cells.length} 格）\n`);
  }
}
