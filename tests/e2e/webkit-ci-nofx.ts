// CI 的 webkit 上，给“依赖帧率的动效时序用例”关掉 backdrop-filter（只改测试环境，产品代码不动）。
//
// 为什么：GitHub Actions 的 Linux webkit 没有 GPU，backdrop-filter 走软件合成，主线程被拖到个位数帧率，
// 按帧采样的时序断言（“头 220 ms 不动”“每一帧不重叠”“倾斜高光走到 90%”）就会挂；本机 Windows webkit、
// iPhone 真机都有 GPU 合成，不卡（负责人至今没反馈真机卡）。ci-webkit-probe 第七轮（run 42201936743，
// 提交 a69c0ed = 9d40848 加探针）用 CSSOM 二分，静止 todos / today 帧率、打勾时帧率：
//   A 原样              38.5 / 1    fps，打勾 3.3 fps
//   B 关顶部两层模糊     0.5 / 16.9 fps，打勾 2.7 fps（没改善）
//   C 只关 .bar/.fab    56.3 / 61.7 fps，打勾 13 fps
//   D 关掉全部模糊      62.1 / 62.1 fps，打勾 59.5 fps
//   E 模糊半径全改 2px  39.5 / 49.8 fps，打勾 2.8 fps（半径大小无关）
// 所以拖慢的是 backdrop-filter 本身（主要是 .bar、.fab，其次底部模糊带），只能整体关掉。
//
// 代价（审查 p4 重点问题 1）：CI 的 webkit 上不再验证“模糊开着时动效时序还对”。这一点软件合成本来也测不准；
// chromium 照样开着模糊跑同样这 8 条。以后真机反馈卡顿，不要以为 CI webkit 覆盖到了，要上真机看。
// 每条关了模糊的用例会打一行 [webkit-ci-nofx]，ci.yml 的 e2e 汇总步骤打出“本轮关模糊的用例数”。
//
// 规则（tests/build/e2e-webkit-nofx.test.ts 把关）：
//   • 只在 CI 的 webkit 项目上生效；chromium、本机 webkit 照常开模糊；
//   • 名单按文件名和完整用例名写死，不用通配；只收“断言动效时序、帧率敏感”的用例；
//   • 玻璃观感类用例（玻璃渲染、透明度、对比度、截图对比、读 backdrop-filter 的）绝不能加进来，否则测试会变弱。
//     加用例要改这里，也要改 tests/build/e2e-webkit-nofx.test.ts 里的写死副本，送审时说明理由。

/** 名单：spec 文件名 → 完整用例名（testInfo.title，参数化用例写展开后的名字） */
export const WEBKIT_CI_NOFX: Readonly<Record<string, readonly string[]>> = {
  'b2-motion-list.spec.ts': [
    'M1 打勾后头 220 ms 里“已完成”组不动，之后只往上走、不回退',
    'N1 打勾：离开的那一项不透明度 > 0.25 的每一帧，它的字不压别的行、组标题的字',
    'N1 删除：离开的那一项不透明度 > 0.25 的每一帧，它的字不压别的行、组标题的字',
    'N1 今天页“没赶上”最后一条打勾：整组离开，不透明度 > 0.25 的每一帧，它的字不压“今天的安排”等别的字（第三轮 P2）',
    'M2 撤销恢复：新行看得见的每一帧都不和别的行、组标题重叠',
  ],
  'b2-tabbar.spec.ts': ['切页过程中底栏一直看得见；液滴点下去就走，不等页面（设计动效评审 D1）'],
  'b2-tilt.spec.ts': [
    'T1：设置里打开（在点按里问、同意）→ 回今天页，不点底栏直接倾斜就跟；换页不再弹窗；关掉以后不跟',
    '新打开 App、开关本来就开着（授权记不住）：倾斜不跟；第一次点底栏弹窗同意后才跟',
  ],
};

/** 关模糊的样式（用构造样式表 + adoptedStyleSheets 挂上，不受 CSP style-src 限制） */
export const NOFX_RULE = '*, *::before, *::after { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }';

/** 这条用例要不要关模糊：CI 下、webkit 项目、文件名和用例名都在名单里 */
export function needsNoFx(opts: { file: string; title: string; project: string; ci: boolean }): boolean {
  if (!opts.ci || opts.project !== 'webkit') return false;
  const base = opts.file.split(/[\\/]/).pop() ?? '';
  return WEBKIT_CI_NOFX[base]?.includes(opts.title) ?? false;
}
