// B3 Q3 守门第 4 条“改动范围守门”（docs/09-路线图/B3-任务单.md 第四节；R-352 ④：“＋”只加事件，外观、透明度、像素不变）
// 底栏外观相关的 5 类文件逐字节钉死：内容的 sha256 必须等于下面的常量；src/motion/glass-*.ts 多一个、少一个都算违规。
// GlassBar.tsx 由代码审查员人工核（Q3 第 4 条：只允许 props 类型和转发给 Pressable 的几行），不进这项自动检查。
//
// 为什么钉哈希、不在 CI 里 git diff：unit.yml 跑单测的作业是浅克隆，拿不到基准提交；不为这一项改 fetch-depth。
// 仓库 .gitattributes 是 `* text=auto eol=lf`，本机和 CI 检出的都是 LF，按原始字节算哈希两边一致。
//
// 基准：
// • 原基准 e96d8e29（B2-UI-a 签字版，docs/03-评审/B2/B2-代码审查-签字.md 第 50、51 行；也是 B3 第一个提交 91876d6b 的父提交）。
// • e96d8e29 之后到 67c5afbb 之间，有 17 个非 B3 提交改过这些文件，都是负责人定过的外观或几何改动（主持人 11-13 核过，定为同意过的改动）：
//   - glass-tilt.ts 整个删掉、glass-ghost.ts 去掉倾斜高光、加 forgetTilt，GlassBar.module.css 的高光写死成原来的后备值：R-373（1e41ff70、e040e643）；
//   - 宽屏侧栏上内边距 88 改 94、侧栏“＋”压住侧栏：R-363（f45e94d1）；
//   - 底栏、“＋”、实色带、渐隐层的 bottom 减 --vh-gap（台账 Q-13“焊死在下面”），键盘弹起改按根节点 data-kbhide 藏、只管窄屏（Q-20），
//     z-index 改成层级变量（Q-21、Q-22 界面去重）：8cd5b1ac、eeacf769、a7ccd5d9、e609d5d8（GlassBarFx.tsx 去掉 kb prop 在 eeacf769）；
//   - base.css 逐个提交：6c1b4a43 同步提示卡 --sn-pad 留白；c1b48a1f 禁整页双指缩放（Q-1）；fa66cf6a R-382、R-391、R-392 和 Q-2、Q-4、Q-9、Q-10；
//     4997e37a R-394（Q-12）；8cd5b1ac、dc42efa4 键盘与底栏、全局运行日志；eeacf769、b7ea73ca 视口几何（Q-20，--dock-bottom 一个公式）；
//     a7ccd5d9、2d882741 界面去重（层级变量表，Q-21、Q-22）；e609d5d8 视口、键盘整块清理；be487ae8、ec0d3cd4 打字条后面整页液态玻璃 R-399、R-400；
//     412ec380 随手记输入框后面的整页模糊 R-401；--g-sheen-img（底栏和“＋”斜上方那片光挪成变量，值同原来的后备值）在 ec0d3cd4。
// • B3 自己的提交没碰这 5 类文件：FA-3 按住“＋”录音 032fbba8 只改了 GlassBar.tsx、motion/components.ts、motion/frame-loop.ts。
// • 所以哈希钉在 main 的 67c5afbb（主持人 11-13 定），B3 之后的提交和它比。
//
// 什么时候允许更新哈希：只有负责人同意改底栏外观时（新的需求编号），才能改下面的常量，并在这段注释里补一行“需求号、提交号、改了什么”；
// R-352 ② 的 .fab:focus-visible 聚焦色如果以后落地，也照这条走。为了让这个测试变绿而改哈希，等于绕过 R-352 ④，不允许。
//
// 哈希更新记录：
// • 11-14 B6 皮肤字体整块评审返工第 1 条（主持人返工单：减少透明 / 减少动态只在 platform/look.ts 判断一次，组件里的 prefers-reduced-* 全删、只留 splash.css），
//   提交 81b4a2bf：GlassBar.module.css、GlassBarFx.module.css、base.css 删掉 prefers-reduced-transparency / prefers-reduced-motion 媒体块（同样的规则原来就有 data-rt / data-rm 一份，系统设置由 look.ts 并进这两个属性），
//   base.css 去掉 data-theme="system" 的 color-scheme（data-theme 只会是 light / dark，返工第 7 条）；glass-ghost.ts 的 reducedTransparency 只看 data-rt、不再监听媒体查询。
//   外观不变：视觉锁定 tabbar-lock、g-plus-hold 0 像素差。
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** sha256（文件原始字节）：67c5afbb 时的；四个在 81b4a2bf 按上面的更新记录换过 */
const PINNED: Record<string, string> = {
  'src/kit/components/GlassBar/GlassBar.module.css': '4fe2fdff0fb033fc77f7795945baf1b6052e9607135fe056fcb38fe6bc9af49f',
  'src/kit/components/GlassBar/GlassBarFx.tsx': '2cd1d04f069b8e10829389ca87e8b647678ba4c0057c1fb42dc777e342d75b0c',
  'src/kit/components/GlassBar/GlassBarFx.module.css': '3a7f59ede916fe65267888adbf53c60f622ba0e56d5c2b079d9665ad01b8dca3',
  'src/motion/glass-ghost.ts': '6211d651c7439b5aa35d8f755f33327b71213e68aa6c26e404b503ea25da701a',
  'src/styles/base.css': 'fe356d597ddf6ed41a7d34c3929c8c72344658f1a3d94adf0cccc34465a2acc0',
};

const sha256 = (rel: string): string => createHash('sha256').update(readFileSync(join(ROOT, rel))).digest('hex');

describe('B3 Q3 守门第 4 条：底栏外观文件不许改（R-352 ④）', () => {
  it('src/motion/glass-*.ts 正好是钉住的那几个：不许多、不许少', () => {
    const now = readdirSync(join(ROOT, 'src/motion'))
      .filter((f) => /^glass-.*\.ts$/.test(f))
      .map((f) => `src/motion/${f}`)
      .sort();
    const pinned = Object.keys(PINNED).filter((p) => p.startsWith('src/motion/')).sort();
    expect(now, '新增或删除了 src/motion/glass-*.ts；改底栏外观要负责人同意，见文件头“什么时候允许更新哈希”').toEqual(pinned);
  });

  it.each(Object.entries(PINNED))('%s 内容和 67c5afbb 逐字节相同', (rel, want) => {
    expect(sha256(rel), `${rel} 改了；B3 只许给“＋”加事件，外观文件不许动（R-352 ④）。确属负责人同意的外观改动，按文件头规则更新哈希`).toBe(want);
  });
});
