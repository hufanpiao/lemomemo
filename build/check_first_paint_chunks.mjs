// 首屏块里不许有 zod（FA-6 ③ 审查 M3 第二轮，主持人 11-04 定按构建产物查）：
// tests/build/first-paint-graph.test.ts 只沿源码的静态 import 走，跟不进 import()——今天页、告知页关口这些懒加载块里引进 rows.ts、
// shared/schema、zod 它拦不住（审查员的变异 R3 实测首屏到 173 KB）。这里用 Vite 的 manifest 算产物里的闭包：
//   入口 index.html，加上首屏一定会下载的几个动态入口（FIRST_PAINT_DYNAMIC），各自的静态 imports 闭包（动态 import 不跟）；
//   闭包里每一块都不许是 zod、zod-jitless、shared/schema/**、shared/manifests/** 的块（按 manifest 的键、src、name 认），
//   内容里也不许出现 zod 的特征字符串（ZOD_MARKS；rolldown 把 zod 并进别的块时按名字认不出）
// 11-05 加农历（接手清单 LUNAR-indirect-import 剩下的兜底）：闭包里也不许有农历数据的块（shared/logic/anniv/lunar*，按 LUNAR_ID 认），
//   内容里不许有农历表的特征数字串（LUNAR_MARKS：压缩后变量名 LUNAR_CN 没了，数据原样在）。check_arch 的 LUNAR 按源码拦，这里按产物兜底
// 用法：node build/check_first_paint_chunks.mjs [--app-dir <目录>]（--app-dir 默认 dist/web/app；build_web.mjs 在体积检查之后跑）
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 首屏期间会下载的动态入口（manifest 的键相对 vite 的 root，即 src/）：今天页、告知页关口和它懒加载的告知页（新用户的第一屏），
 * 今天页里的提醒部件：未同步提示条、每行的未同步小标记一打开就挂；错过提醒那一行（MissedReminders）等提醒引擎 armed 或 remindDown 以后才挂
 *（REMIND-shown-persist 修订 1 P2，11-05 改掉 J1 的“一打开就挂”，openedAt 已删）——armed 可能落在首屏期间，所以照旧留在名单里受同样的检查
 *（③ 审查第三轮 R3b 漏登过它）。
 * 这份名单由 tests/build/first-paint-graph.test.ts 从源码推着核对：首屏路径上新加的 import() 没归类就挂。
 * 名单只是第一道；首屏期间实际下载了什么，由 e2e tests/e2e/b2-first-screen-budget.spec.ts 按页面时钟兜底
 */
export const FIRST_PAINT_DYNAMIC = [
  'features/today/ui/TodayPage.tsx',
  'features/onboarding/ui/ConsentGate.tsx',
  'features/onboarding/ui/ConsentPage.tsx',
  'features/reminders/ui/MissedReminders.tsx',
  'features/reminders/ui/UnsyncedRemind.tsx',
  'features/reminders/ui/UnsyncedRemindMark.tsx',
];

/** manifest 键、src、name、file 里出现这些就是禁区的块：zod、zod-jitless、shared/schema、shared/manifests；
 *  shared/ 在 vite 的 root 外面，不是动态入口的那些块只有“_名字-哈希.js”的键，rows.ts 认成 _rows- */
const FORBIDDEN_ID = /(^|[/_])zod([-./]|$)|zod-jitless|shared\/schema\/|shared\/manifests\/|(^|\/)_rows-/;
/** zod 的特征字符串：zod 的块里有，首屏别的块里没有（11-04 在产物里核对过） */
export const ZOD_MARKS = ['$ZodType', 'ZodError'];
/**
 * Motion（动画库）的特征字符串：只该出现在 src/motion/motion-impl.tsx 那一块（appPainted() 之后才下载，R-354）。
 * 前端 A 11-07 在产物里核对过：这两个串只出现在 motion-impl-*.js；首屏闭包里出现就是动画库又被静态引回首屏
 */
export const MOTION_MARKS = ['transformPerspective', 'whileInView'];
/** 农历数据的块：shared/logic/anniv/lunar.ts、lunar-data.ts（shared 在 vite root 外，块键是“_lunar-哈希.js”） */
const LUNAR_ID = /shared\/logic\/anniv\/lunar|(^|\/)_lunar(-data)?-/;
/**
 * 农历表的特征数字串：LUNAR_CN.years 的前三项原样（压缩不改数字和逗号）。tests/build/first-paint-chunks.test.ts 从 lunar-data.ts 现取核对，
 * 数据换了就红；LUNAR_KR 现在是空表，有了数据以后那条测试要求在这里补它的前三项
 */
export const LUNAR_MARKS = ['[-25153,1874],[-24799,3749],[-24444,46666]'];

/** 从 keys 出发只沿 imports（静态）走，返回经过的 manifest 键 */
export function staticClosure(manifest, keys) {
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) return;
    if (!manifest[key]) throw new Error(`manifest 里没有 ${key}`);
    seen.add(key);
    for (const k of manifest[key].imports ?? []) visit(k);
  };
  for (const k of keys) visit(k);
  return [...seen];
}

/** 查一份 manifest：返回违规（空数组就是通过）。read(file) 读块的内容 */
export function checkFirstPaint(manifest, read, dynamic = FIRST_PAINT_DYNAMIC) {
  const missing = dynamic.filter((k) => !manifest[k]);
  if (missing.length) return missing.map((k) => `manifest 里找不到首屏动态入口 ${k}（改了首屏路由要同步 FIRST_PAINT_DYNAMIC）`);
  const bad = [];
  for (const key of staticClosure(manifest, ['index.html', ...dynamic])) {
    const c = manifest[key];
    const ids = [key, c.src ?? '', c.name ?? '', c.file];
    if (ids.some((s) => FORBIDDEN_ID.test(s))) bad.push(`首屏闭包里有禁区的块：${key}（${c.file}）`);
    if (ids.some((s) => LUNAR_ID.test(s))) bad.push(`首屏闭包里有农历数据的块：${key}（${c.file}）`);
    if (!c.file.endsWith('.js')) continue;
    const text = read(c.file);
    const hit = ZOD_MARKS.find((m) => text.includes(m));
    if (hit) bad.push(`首屏块 ${c.file}（${key}）里有 zod 的代码（含 ${hit}）`);
    if (LUNAR_MARKS.some((m) => text.includes(m))) bad.push(`首屏块 ${c.file}（${key}）里有农历表的数据`);
    const mo = MOTION_MARKS.find((m) => text.includes(m));
    if (mo) bad.push(`首屏块 ${c.file}（${key}）里有动画库 Motion 的代码（含 ${mo}；它只该在 motion-impl 那一块，R-354）`);
  }
  return bad;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const i = process.argv.indexOf('--app-dir');
  const appDir = i > 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : resolve(root, 'dist/web/app');
  const manifestPath = [resolve(appDir, '.vite/manifest.json'), resolve(appDir, '../../vite-manifest/manifest.json')].find((p) => existsSync(p));
  if (!manifestPath) {
    console.error('找不到 Vite 的 manifest.json，先运行 npm run build');
    process.exit(1);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bad = checkFirstPaint(manifest, (f) => readFileSync(resolve(appDir, f), 'utf8'));
  if (bad.length) {
    console.error('首屏块里有 zod、农历数据或动画库（FA-6 ③ M3、LUNAR-indirect-import、R-354）：');
    for (const b of bad) console.error(`  ${b}`);
    process.exit(1);
  }
  console.log(`首屏块里没有 zod、农历数据、动画库：入口 + ${FIRST_PAINT_DYNAMIC.length} 个动态入口的静态闭包都查过`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
