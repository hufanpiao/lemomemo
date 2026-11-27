// 逐帧对照（前端-15）：today-motion-frames.perf.ts 改前、改后两次截图逐张比字节（同一浏览器、同一 PNG 编码，像素一样字节就一样）。
// 用法：node tests/perf/compare-frames.mjs <改前标签目录> <改后标签目录>
// 两边都是 <浏览器>/<场景>/0000.png 这样的结构；打印每个场景的帧数、不一样的帧号，全一样退出码 0，否则 1
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const [a, b] = process.argv.slice(2);
if (!a || !b) {
  console.error('用法：node tests/perf/compare-frames.mjs <改前目录> <改后目录>');
  process.exit(2);
}
let bad = 0;
for (const browser of readdirSync(a)) {
  for (const scene of readdirSync(join(a, browser))) {
    const da = join(a, browser, scene);
    const db = join(b, browser, scene);
    const fa = readdirSync(da).filter((f) => f.endsWith('.png')).sort();
    const fb = existsSync(db) ? readdirSync(db).filter((f) => f.endsWith('.png')).sort() : [];
    const diff = fa.filter((f) => !fb.includes(f) || !readFileSync(join(da, f)).equals(readFileSync(join(db, f))));
    if (fa.length !== fb.length) diff.push(`帧数 ${fa.length} ≠ ${fb.length}`);
    bad += diff.length;
    console.log(`${browser} ${scene}：${fa.length} 帧，${diff.length ? `不一样：${diff.slice(0, 20).join(' ')}${diff.length > 20 ? ' …' : ''}` : '全一样'}`);
  }
}
process.exit(bad ? 1 : 0);
