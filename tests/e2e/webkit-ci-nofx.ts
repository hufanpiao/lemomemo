// CI 的 webkit 上，给“依赖帧率的动效时序用例”关掉 backdrop-filter（只改测试环境，产品代码不动）。
//
// 为什么：GitHub Actions 的 Linux webkit 没有 GPU，backdrop-filter 走软件合成，主线程被拖到个位数帧率，
// 按帧采样的时序断言（“头 220 ms 不动”“每一帧不重叠”“倾斜高光走到 90%”（倾斜 R-373 已删除））就会挂；本机 Windows webkit、
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
    'N1 打勾：收起时这一行高度单调降到约 0、下一行单调上移，卸载前后下一行不跳；离开的那一份看不见',
    'N1 删除：离开的那一项不透明度 > 0.25 的每一帧，它的字不压别的行、组标题的字',
    'N1 今天页“没赶上”最后一条打勾：整组离开，不透明度 > 0.25 的每一帧，它的字不压“今天的安排”等别的字（第三轮 P2）',
    'M2 撤销恢复：新行看得见的每一帧都不和别的行、组标题重叠',
  ],
  'b2-tabbar.spec.ts': ['切页过程中底栏一直看得见；液滴点下去就走，不等页面（设计动效评审 D1）'],
  // 11-20 加：收起要出帧才走得动，和上面 N1 打勾同一件事（离开原组时剩的高度，下一行跳不跳）；CI 7555dd5a、62fe80f0 连挂“剩 56px”。
  // 这条只量时间线和高度，方框颜色拆到同文件“亮柠檬黄”那条、照常开模糊
  'todo-done-timeline.spec.ts': ['删除线勾上当下起画、90 ms 内画满；方框 0.45 起回弹到约 1.22 再落回 1；14 个小点；约 720 ms 后收起、离开原组时已经收完'],
  // 11-22 加：打字条开着时整页液态模糊（Mist）+ 打字条自己的模糊一起在，CI webkit 掉到约 1 帧/秒，点一下要等“位置停稳”两帧，每一步约 4 秒；
  // 这两条一条要点十几下，CI 875e28a0 日历那条两次都在第 30 秒卡在点“记下”（运行日志点击间隔 t=7.01→10.86→14.66→18.68→23.41→27.46），
  // 待办那条 28.8 秒擦线过。只核签的识别、点选和写进库的列，不看玻璃；打字条的模糊观感由别的用例和 chromium 照常验
  'plus-fields.spec.ts': [
    '待办页：识别填签，点分类新建、日期和其他时刻、提醒点掉，记下写进 todos',
    '日历页：日期签默认是选中的那天；日程改全天跨 3 天、点亮提醒，记下写进 events',
  ],
  // 11-24 加：AI 抽屉的整页模糊下 CI webkit 约 0.5 帧/秒，两次点击隔 11.4 秒（7143928f 运行日志 t=71.00→82.42），超过“全部清空”4 秒复位；
  // 这两条只核列表、分页和清空流程，不看玻璃；抽屉的模糊观感由 chromium 照常验
  'b4e-chat-memory.spec.ts': [
    '④ 120 条：先出一页，滚到底接着读完；全部清空写总数',
    '② 全部清空要点两次，清完没有撤销',
  ],
  // 11-25 加：同一个 AI 抽屉，出现时从底边滑上来（transform 过渡），这三条等滑完（transform 变 none）再量位置、拖把手；
  // CI webkit 上整页模糊 + 抽屉玻璃软件合成，5 秒里一帧没出，transform 停在起点 680.375
  // （95019a6a 的 45506635005 ①⑥、15278df0 的 45375554244 ⑤、94b7b46b 的 45361415717 ⑥ 都这样挂，报的值一模一样）。
  // 容器加压对照（Playwright 同一镜像、4 核 4 个 worker、①⑥ 各 4 遍）：原样 8 遍挂 5 遍、报的正是 680.375；只关模糊 8 遍全过。
  // 只核停靠点、位置、编号、用量和点开，不看玻璃、不读颜色、不截图对比（shots 只在 Chromium 设了 LEMO_SHOT_DIR 时存评审图；
  // 原来 ① 里读日程竖条项目色那一句拆到同文件 ①b、照常开模糊）；抽屉的模糊观感由 chromium 照常验
  'b4c-chat.spec.ts': [
    '① 问 AI → 半屏抽屉：回答、角标、依据；拉满全列；点条目打开原条目',
    '⑤ 管理员：今天已用 60 次照样回答，用量行写“今天 60 次 · 不限”，不写“/ 50”、不出用完卡',
    '⑥ 联网回答：两条网页来源 + 一条日程同一套编号；点网页行新窗口打开原网址',
  ],
  // 11-24 加：打字条的整页模糊上再叠新建页的 clip-path 长成动画（motion 的 growSwap），CI webkit 约 3 秒才出一帧（b70bfe69 容器诊断：
  // 点“展开编辑”后 3 秒只出 4 帧，三条动画一直 pending、currentTime 0），“长完才收打字条”等不到，5 秒断言超时；运行日志只有 swap grow go、没有 grow end。
  // 这四条只核换页顺序（逐帧读 DOM 在不在）、历史记录和收尾后的 DOM，不看玻璃、不截图；打字条的模糊观感由 chromium 和别的用例照常验
  'plus-expand-no-flash.spec.ts': [
    'today：点“展开编辑”直接换成新建页，没有只剩原页面的那一帧',
    'todos：点“展开编辑”直接换成新建页，没有只剩原页面的那一帧',
    'calendar：点“展开编辑”直接换成新建页，没有只剩原页面的那一帧',
    '今天：打开打字条、展开编辑、返回今天，全程不压历史；退回今天打字条不在',
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
