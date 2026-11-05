# B2 · FA-7 液态玻璃底栏 · 实现方案（前端 B，11-05；负责人 11-05 已定第 7 节各项）

> **负责人 11-05 的决定**（以下正文按这些执行）：
> ① 手机版设置入口：今天页右上角头像（名字第一个字），点进设置；底栏不加设置页签。
> ② 底栏 4 个页签，点“随手记”显示“即将推出”（中韩文案都要）。
> ③ “＋”按页新建：今天页、日历新建日程，待办页新建待办；去掉待办页右上角原来的“＋”。
> ④ 简洁皮肤也用液态玻璃（和玻璃皮肤一样的底栏）。
> ⑤ 首屏：外壳先按“进首屏”做，尽量小；前端 A 在 core/manifests.gen.ts 腾约 2.5 KB，腾不出来再定。
> ⑥ 倾斜高光开关默认关，打开时再请求权限。

依据：B2-任务单 FA-7（第 166 行）、第 236、254 行；架构设计-v4 0.25（渐进模糊带）、0.27 第 5 点（R-153 正式做法）、17.1/17.2；
接手清单 NAV-today-no-settings、UI4-B1-C2/C3、TILT-b2；设计稿 皮肤-v4/液态玻璃-真机试验.html（参数以它为准）、线框-v4-定稿.html。

## 1. 现状

- 代码里还没有底栏：手机版今天、日历、待办三页之间靠地址切换，主屏幕版没有地址栏，所以进不了设置（NAV-today-no-settings）。
- 令牌已经齐全，不用补：glass.css、simple.css 里已有 `--g-tint/-fb`、`--g-rim`、`--rim-shade`、`--g-copy-fx`、`--g-drop-fx`、`--g-ad-*`（自动深浅那组）、`--g-pill-solid`、`--g-halo`、`--g-fab-tint`，以及 `--dur-drop`、`--ease-drop`、`--ease-gel`、`--dur-glass`。只需在 tokens.ts 确认动效用到的几项已导出，跑 `build/tokens.py --check`。
- 待办页右上角现有一个“＋”（TodosPage.module.css `.add`，`--fab-bg` 实色小胶囊）。
- 前置事项：UI4-B1-C2（view-transition 期间 `pointer-events:none`）还没做，底栏切页前要补上；C3 已做（017a13d）。

## 2. 组件放哪

| 内容 | 位置 | 首屏带不带 |
|---|---|---|
| 底栏外壳：4 个页签 `<a href="#/…">`、选中项 `aria-current="page"`、“＋” `<button>`、液滴（纯 CSS 定位） | `src/kit/components/GlassBar/GlassBar.tsx` + `GlassBar.module.css` | 带 |
| 渐进模糊带（5 层 backdrop-filter 1/2/4/8/16px + mask，高 160px，底色渐变到 `--bg` 55%） | `GlassBar/BlurBand.tsx`（纯 CSS） | 带 |
| 液滴滑动、按住放大 1.16、`--dur-drop` 0.55s、translateX | `src/motion/drop.ts`（只动 transform/opacity，`data-rm="1"` 时直接换位） | 带（很小） |
| 内容副本引擎：`data-ghost` 候选（IntersectionObserver）+ cloneNode 绝对定位 + 副本 `aria-hidden`/`inert`/去 href/去 id/输入框 disabled，隐私记不建副本 | `src/motion/glass-ghost.ts`（rAF 只在 motion 里，A25） | **不带**，首屏画完后按需下载 |
| 自动深浅（面积比 >55% 设 `data-ad="dark"`，<45% 换回，0.35s） | `src/motion/glass-autodark.ts` | 不带，和副本引擎一起下载 |
| 帧循环：只在滚动、动画时跑，停下 100ms 后停 | 同上，副本引擎内 | 不带 |
| 倾斜高光（TILT-b2，最后做） | `src/platform/motion-sensor.ts` + 设置 › 皮肤 的开关 | 不带 |

副本引擎下载完之前，底栏用 `backdrop-filter` 后备（`--g-tint-fb`），外观接近；`data-rt="1"`（减少透明效果）时一直用 `--glass-solid` / `--fab-bg` / `--g-pill-solid`，永远不下载引擎。

## 3. 怎么接入三页和路由

- 底栏是 App 级的一块，不放在各页里：App 按当前路由决定显示与否（today、calendar/cal、todos 显示；随手记是否显示见第 7 节），并给它单独的 `view-transition-name: tabbar` + `animation:none`，切页时底栏不跟着换。
- 选中项按 `pageOf(route.name)` 算（`#/cal/…` 也算日历）；“日历”页签链到 `#/calendar`（本月）。
- 各页内容区底部留出底栏高度（`padding-bottom: calc(底栏高 + safe-area)`），用一个 kit 的 CSS 变量 `--tabbar-h`，三页各加一行。
- 三页里底栏附近会出现的元素加 `data-ghost`，项目色写 `data-color`，并确保自带完整样式（副本脱离原父级也画得对）。
- **App.tsx 现在归前端 A**：接入那一步（App 里挂 `<GlassBar route=… />`、加 C2 的 `pointer-events:none`）等主持人通知再做。之前我只在新文件里做组件、样式、液滴、自动深浅、副本引擎，配单测和一个 dev 演示页（不进正式路由）。

## 4. 设置入口

定稿线框只写清了电脑版（侧栏底部“⋯”里的设置入口和头像），手机版右上角定稿写的是放大镜；历史版本先后出现过“右上角齿轮”“右上角头像”“‘胡’是设置入口”。**手机版设置入口在哪需要产品决定**（见第 7 节第 1 条）。
我建议：今天页顶部右上角放头像（名字第一个字），点进 `#/settings`；日历、待办不放（设置只从今天进），这样三页右上角的放大镜不受影响。底栏本身不加“设置”页签。决定后，Placeholder.tsx 里临时的设置链接一起删，e2e b1-settings.spec.ts 改回从界面点进去。

## 5. 首屏体积

- 首屏会多：外壳 TSX + CSS + 模糊带 + 液滴 ≈ **1.5～2.2 KB（gzip）**。副本引擎、自动深浅、帧循环 ≈ 4～6 KB，放首屏后按需下载，不计入。
- 当前今天页首屏 152.3 KB，前端 A 正在压到 150 以内；底栏这 2 KB 要算在里面，需要 A 那边再多留约 2 KB 余量，或者把底栏外壳也改成画完后再挂（代价：今天页冷启动第一帧没有底栏，几十毫秒后出现）。**这个取舍请主持人定**（第 7 节第 5 条）。
- 做完我按页面时钟口径在 chromium、webkit 各量一次（8830 端口），并补 first-paint-graph 的归类。

## 6. 要动的现有文件（接入时）

- `src/app/App.tsx`：挂底栏、按路由显示（**等通知**）。
- `src/styles/base.css`：`::view-transition` 期间 `pointer-events:none`（C2）、`tabbar` 的 view-transition 规则。
- `src/app/router.ts`：只读用，不改；如需 `hrefOf` 之外的帮助函数再说。
- 三页：TodayPage、日历页、TodosPage 加底部留白和 `data-ghost`；待办页现有右上角“＋”是否保留见第 7 节。
- `src/kit/components/Placeholder.tsx`：删临时设置链接（设置入口定了以后）。
- `tests/e2e/b1-settings.spec.ts`：改回点界面进入设置；新增 `b2-tabbar.spec.ts`（切页、选中态、读屏、减少动态/透明效果、C2）。
- `build/check_contrast`：加“玻璃色对栏字 ≥ 3:1”一项。
- 文件登记册.md：登记新文件。
- 不动：src/main.tsx、src/motion 已有规则、sync、push-claim-run.ts、check_first_paint_chunks.mjs。

## 7. 需要产品决定的地方

1. **手机版设置入口**：今天页右上角头像（我的建议）／每页右上角齿轮／其他。
2. **第 4 个页签“随手记”**：B2 随手记还没上线，底栏是放 3 个页签，还是放 4 个、随手记点了显示“即将推出”？（设计稿是 4 个）
3. **“＋”在 B2 点了做什么**：设计里是“按住说话、点一下打字”（随手记），B2 没有语音和随手记。选项：今天页、日历新建日程，待办页新建待办；或 B2 先不放“＋”。待办页右上角现有的“＋”到时是否去掉？
4. **简洁皮肤要不要液态玻璃**：架构写的是“手机版有底部导航的四页”，没区分皮肤；simple.css 也有整套 `--g-*`。是否简洁皮肤也用玻璃，还是简洁皮肤用实色底栏？
5. **首屏 2 KB 的取舍**：底栏外壳进首屏（要 A 多省 2 KB），还是画完后再挂（第一帧没有底栏）。
6. **倾斜高光开关**：设置 › 皮肤 里的开关默认开还是关（iOS 第一次点底栏时会弹系统权限框）。

## 8. 顺序

1. 新文件：GlassBar 外壳 + 模糊带 + 液滴 + 单测（等决定期间就能做）；
2. 副本引擎 + 自动深浅 + 帧循环（按需下载）+ 单测 + 变异验证；
3. 等通知后接入 App 和三页、C2、设置入口、e2e、两浏览器量首屏、截图；
4. 最后做倾斜高光 TILT-b2。

## 9. 进度（11-05 前端 B）

已做（第 1 步 + 第 3 步的接入部分）：
- 外壳：kit/components/GlassBar/，包括 4 个页签、“＋”、液滴的滑动和果冻、渐进模糊带。材质用 backdrop-filter 后备，减少透明效果时用实色，减少动态效果时液滴直接换位置。
- 接入：App.tsx 按路由挂底栏（today、calendar/cal、todos、notes），映射在 app/tab-of.ts。
  - “＋”：今天、日历新建日程，待办新建待办；随手记不出“＋”，页面只写“即将推出”。
  - 待办页右上角原来的“＋ 新建”已去掉。
  - 今天页右上角头像（display_name 第一个字，没有名字时画人形）进设置。
  - 占位页的临时设置链接已删；e2e b1-settings 改回从界面点头像进设置。
- base.css：`::view-transition { pointer-events: none }`（UI4-B1-C2，配 e2e）；底栏、“＋”切页时不淡入淡出（view-transition-name tabbar、tabbar-add，已登记 VT_FIXED）。
- 内容副本引擎、自动深浅、帧循环：motion/glass-ghost.ts，首屏画完以后才下载。first-paint-graph 守护它不进首屏的静态闭包。
- 设计动效评审（docs/03-评审/B2/B2-设计动效评审-FA7底栏外壳.md）的改动：
  - D1：底栏挪到页面的 Suspense 外面，自带错误边界和 Suspense；第一个页面（main）出现以后才画，之后不再跟页面一起藏。点页签时液滴马上往目标页走，不等路由；路由一变（包括后退）就作废，回到按路由画。e2e 逐帧查底栏和“＋”一直可见，液滴从按下算起 100ms 内开始走。
  - D2：减少透明效果时，选中液滴改为 --g-pill-solid（--step-off 一档）加 1.5px 描边 --g-pill-edge（对栏底 ≥ 3:1）。这推翻了 R-244 的“沿用 --glass-solid”。
    - 为什么不只改一块中灰：深色玻璃皮肤里，一块中灰没法同时满足“对栏底 ≥ 3:1”和“选中字压在上面 ≥ 4.5:1”。
    - tokens.json、视觉稿已同步；check_contrast 加了 g-pill-edge、g-pill-solid-text 两项。
  - D3：只有按住当前选中的页签才放大，倍数 1.12，时长 --dur-drop-press（新令牌 0.25s），曲线 --ease-press。
  - 建议项：
    - 自动深浅改成深色一层（.adTint）和浅色一层交叉淡入淡出 opacity，不再过渡背景色；
    - “＋”换成 Pressable，有按下回弹；外圈加 1px --step-off 细灰边；
    - 随手记标题改为“随手记 / 메모”，说明用正文字体；
    - 三页底部留白改为 --tabbar-pad，即 --tabbar-h（126px，模糊带高度）加安全区再加 16px，在 base.css 里定义。
  - L1：果冻改由 glass-ghost.ts 的 playGel（WAAPI）放。连点时从当前形变接着放，不重挂元素；引擎下载到以前、或者没有 WAAPI 时，退回 CSS 动画、换 key 重挂。不进首屏。
- 负责人 11-05 定 D4～D6：
  - D4 果冻参数维持现状；
  - D5 电脑版现在就做侧栏，做法已交主持人审，等回复；
  - D6 头像看得见的圆 36px（::before 画），--panel-2 底色加 --step-off 细边，触控区 44。
- D2 推翻 R-244 的部分：主持人说先别提交，等负责人；代码留着。
- 第 3 项 键盘弹起时藏底栏：
  - App 的 TabBar 在首屏画完以后下载 platform/viewport.ts，订阅 watchKeyboard，给 GlassBar 传 hide；
  - 底栏、“＋”、模糊带带 data-kb="1"，visibility:hidden；
  - 这段接线占首屏 0.2 KB，做法已报主持人，等定。
- 第 5 项 日历“＋”带日期：
  - calendar/hooks/new-date.ts：日历页挂着时记下点“＋”那一刻选中的日期，新建日程表单读它当默认日期，挂上以后清掉；
  - 外壳不加代码。
- 首屏：149.8～149.9 KB（chromium、webkit 一致），离硬线只剩约 0.1 KB。

### 9.1 11-05 后半天（主持人定首屏 ③ → ①，以后外壳每加一行先量首屏再报）

- 首屏 ③：模糊带、果冻、按住放大、深色玻璃层、副本引擎加载挪进 GlassBarFx.tsx（首屏画完以后 import()），外壳只留页签、“＋”、液滴位置和 D1；首屏降到 149.5～149.6。主持人随后选 ①：维持现状，D1 不挪。
- 设计复审一 R1：webkit 过渡期间不画“新那份”，底栏和“＋”会消失。改成新旧两份都 animation:none、都画着、pointer-events:none（base.css）。e2e 在过渡中途停住截图比像素（b2-tabbar-transition.spec.ts），旧写法 webkit 红 16.4%。
- R2：键盘弹着时底栏和“＋”visibility:hidden（不进 Tab 顺序）。R3：页签和“＋”有 :focus-visible 焦点框。
- 设计复审二 R4：过渡中点底栏被吞（点按算到 <html> 上）。GlassBarFx 在 <html> 上听 click，按坐标找页签或“＋”替它点。R5：比像素的门槛收紧到只看差 >32 的像素，三种“没画”变异都 100% 红。复审三通过。
- 第 4 项：深色 --g-tint 保持 0.44；check_contrast 加“负责人已接受的例外”名单（8 条，floor 必须等于精确值截断到 4 位，否则退出码 2；名单外照样报错）。g-ad-halo 的底改成实际画法 --g-ad-tint。代码审查 M5、L11 复审 9.0 通过。
- L5：副本去掉 name、form（同名单选框会把原件的选中挤掉）。
- K8：base.css 定义 --dock-bottom、--undo-h，宽屏里覆盖 --dock-bottom；浮条由前端 A 改用。
- D5 电脑版侧栏（(width >= 900px)、不放 ⋯、方案 A 只用 CSS）：左边竖排，上“＋”、中四个页签、下设置入口；选中项 --accent 底；没有模糊带、液滴和副本；页面让出左边 110px；宽屏藏今天页头像。
  - 设计复审三 S1：设置入口原来由 GlassBarFx 放进侧栏，分包没到或下不来时宽屏没有设置入口 → 挪进首屏外壳的 nav（e2e 拦掉 GlassBarFx 分包验证）。
  - S2：宽屏时“＋”在 DOM 里排在 nav 前面，Tab 顺序和画面一致（外壳 useSyncExternalStore 跟 matchMedia；单测 GlassBar-wide、e2e 按 Tab 走一遍）。
  - S3：(hover: hover) 下没选中的页签悬停铺 --panel-2、字色 --text，设置圆悬停 --step-off。
  - 三个变异都红。首屏 149.5 → 149.7 KB。
  - S4（设置页宽屏没有侧栏）、R6（过渡中点页面内容仍被吞）成本大，主持人定写进接手清单：FA7-S4-settings-rail、FA7-R6-vt-taps。
- 读屏名统一为“主导航 / 주 메뉴”（韩文标了待 R-106 审校）。
- TILT-b2 倾斜高光（做法 ②；主持人：开关在设置页、存本机、默认关，倾斜监听在首屏后的副本引擎里，外壳不加代码）：
  - 设置 › 皮肤（新分组，排在界面语言后面）放“倾斜高光”开关（role=switch，画法照提醒页免打扰）。打开时在这次点按里同步调 platform/motion-sensor.ts 申请方向权限（iOS 才有），同意才记成开，拒绝保持关并提示一句；存本机 localStorage 的 lemo.tilt。
  - motion/glass-tilt.ts 由 glass-ghost.ts 的 startGlass 启动和停止：开关开着、没减少动态效果才听 deviceorientation。iOS 授权记不住（R-247），每次打开 App 后第一次点底栏（click）才再问；一次打开只问一次，拒绝或没读数停在默认位置。参数照试验页第 2 版：gamma 限 ±35°、beta 限 0～90°，每帧往目标靠 15%，靠够了停帧；往底栏和“＋”写 --g-sx、--g-sy、--g-hx。
  - 监听没直接写进 glass-ghost.ts：写进去会超过 300 行代码上限，拆成 glass-tilt.ts，只有 glass-ghost.ts 引它，一起首屏后下载。
  - GlassBar.module.css：.glass 的亮边横向偏移乘 --g-hx，::after 径向高光中心用 var(--g-sx, 22%) var(--g-sy, -30%)；没开时和原来一样。
  - 宽屏侧栏不开副本引擎，也就没有倾斜高光（电脑没有陀螺仪）。
  - 测试：glass-tilt 单测、设置皮肤单测、键名核对（tests/build/tilt-key.test.ts）、e2e b2-tilt.spec.ts（假 iOS 授权，两种浏览器）。首屏不变（149.7）。

还没做 / 等决定：
- “设置 › 皮肤 › 减少透明”开关（写 data-rt，R-84）：主持人 11-05 说不做。
- 负责人真机验收 P2-11（倾斜高光按做法 ② 验）。

已有问题：webkit 里在应用内跳进编辑页会报一条 CSP style-src-attr。前端 A 已查明是 WebKit 新建 <select> 时的误报，csp-fixture 精确放过这一种。

### 9.2 11-05 晚：TILT 设计评审 T1/T2/T3/T5，R6 收紧（主持人 + 代码复审 L17 + 设计复审五 R6-a）

- TILT T1、T2：底栏挂上时先不在点按里问一下（quietGranted）：permissions 的 accelerometer、gyroscope 都是 granted，或 requestPermission 不在点按里直接回 granted（这次打开里已同意过，例如刚在设置页打开开关），就直接听；
  iOS 没同意过会被拒、Chromium 回 prompt，都不记成拒绝，照旧等第一次点底栏再弹窗。说明文字和注释改成“要授权的浏览器（iOS，新版安卓 Chrome 也有）”。
- T3：拒绝提示加怎么重试（关掉柠檬记再打开、再开开关）；中韩都改，韩文两条标 REVIEW(ko) 待审。
- T5：screenAxes 按 screen.orientation.angle 换轴（90 / 270 / 180）。Windows 上 Playwright 的 webkit 竖屏也报 angle=90，e2e 在原型上钉成 0；换轴方向以 T4 真机为准。
- e2e b2-tilt：假 requestPermission 照真机规矩答（点按里同意并记住，不在点按里没同意过就拒绝），T1“设置打开 → 回今天页 → 不点底栏直接倾斜就跟”；新打开 App 要先点底栏一条。
- R6 收紧：页面内容只代点导航类的链接、按钮；复选框、开关、单选、带 aria-pressed / aria-checked 的、表单控件、label 都不代点（点到的东西本身或外面套着的都算）；
  删除等危险按钮加 data-no-proxy（今天页、待办页的 ×，待办、日程编辑页的删除，账号注销入口和提交）也不代点；门槛维持 50 ms。
- L17 e2e（b2-vt-taps）：过渡中点今天页待办的勾选圈、×：都不代点，数据不变、没有撤销条；过渡外正常点 × 有撤销条、能撤销。
- 变异：去掉 quietGranted（单测 5 红、e2e T1 两浏览器红）、不换轴（单测红）、不认 data-no-proxy（单测、L17 两浏览器红）、不查非导航（单测红；e2e 不红，因为 × 本身带标记、勾选圈不是 TAPPABLE）。
- 首屏：TILT、R6 都在首屏后分包；今天页、待办页的 data-no-proxy 去掉前后都是 150.2 KB（副本按 5ca1e8a 加主仓库全部未提交改动），我这轮没有可量出的增量；
  150.2 超线来自同步进来的别人未提交改动（主仓库里 app、sync-notice、reminders 等），需要主持人看。
