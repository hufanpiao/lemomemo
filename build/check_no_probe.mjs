// 正式产物里不能有 R-68 探测页和 voice-probe 路径（B3 任务单 Q1 第 ⑧ 条、FA-0；验收“正式产物里搜不到二者”），也不能有 CSP 试验页
// 探测页只在非正式版的试验页 #/dev-csp/voice 下懒加载（src/app/dev/VoiceProbe.tsx、src/platform/voice-probe.ts）；
// 正式版的试验页整块被摇掉，这里再按文本兜底：扫 --dir（默认 dist/web）下所有文件，搜到下面任一标记就失败
// 调用：build/build_web.mjs 在 mode=production 时自动跑；release-build.yml 构建后另跑一遍。和 voice-probe 同一个 PR 删
// 用法：node build/check_no_probe.mjs [--dir dist/web]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 探测页、探测函数的标记（函数路径、页面根节点的 testid、组件名、页面标题），
 * 以及 CSP 试验页（探测页挂在它下面；App.tsx 用构建期常量挡，正式构建整块删掉）的块名、根节点 testid、标题，防止以后又混进正式产物。
 * 试验页的标记不随 voice-probe 删
 */
export const PROBE_MARKERS = ['voice-probe', 'VoiceProbe', 'Voice probe (R-68)', 'CspLab', 'csp-lab', 'CSP lab', 'vh-probe', 'vh-timeline', 'lemo-vh-tl', 'diag-boot', 'splash-probe', 'lemo-sp-color', 'sp-probe', 'splashHold', 'KbAccessoryProbe', 'kbacc-probe', 'Keyboard bar test', 'caret-sync', 'lemo-caret-sync', 'Caret sync', 'lemo-run-log', 'Copy run log', 'Send run log'];   // vh-probe：11-10 R-371 底栏偏高真机探测（诊断页按钮；11-12 已删，留着防回来；诊断按钮外框 testid settings-vh-probe 还在，只进非正式版）；vh-timeline、lemo-vh-tl：同一天的冷启动时间线（分包名和本机存储键名），正式包都不能带；（vh-gapfix、lemo-gapfix 11-11 拿掉：Gap fix 负责人真机通过、改成默认开，正式版也带）；diag-boot：非正式版诊断启动件的分包（运行日志、时间线、启动画面颜色诊断的入口，11-11 从 main.tsx 收进来）；splash-probe、lemo-sp-color、sp-probe：11-11 台账 Q-2 启动画面颜色诊断（分包名、本机存储键名、样式类名和属性；splashHold：启动画面多留 8 秒的标记；11-12 随 Q-2 结案已删，留着防回来）；KbAccessoryProbe、kbacc-probe、Keyboard bar test：11-11 台账 Q-11 键盘上方输入辅助条诊断（分包名、testid、诊断区按钮字；11-12 随 Q-11 关闭已删，留着防回来）；caret-sync、lemo-caret-sync、Caret sync：11-11 台账 Q-8 光标偏位试验（已删，留着防回来）；lemo-run-log、Copy run log：11-11 全局运行日志（只进非正式版）；Send run log：11-11 运行日志一键发送的按钮字（只进非正式版；表名 diag_logs 在数据清单快照里，正式包也有，不当标记）

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

/** 返回 [{file, marker}]，空数组 = 干净 */
export function findProbe(dir) {
  const hits = [];
  for (const file of walk(dir)) {
    const text = readFileSync(file).toString('latin1');
    for (const marker of PROBE_MARKERS) if (text.includes(marker)) hits.push({ file: relative(dir, file), marker });
  }
  return hits;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--dir');
  const dir = resolve(ROOT, i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : 'dist/web');
  const hits = findProbe(dir);
  if (hits.length) {
    for (const h of hits) console.error(`正式产物里有探测页、voice-probe 或 CSP 试验页：${h.file}（${h.marker}）`);
    process.exit(1);
  }
  console.log(`正式产物里没有探测页、voice-probe 和 CSP 试验页：${dir}`);
}
