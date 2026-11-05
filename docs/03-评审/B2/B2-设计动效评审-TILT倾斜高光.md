# B2 设计兼动效评审：TILT 倾斜高光（做法 ②，默认关）

- 评审员：设计动效评审员（只读，默认不通过，10 分制 8 分过）
- 日期：2026-11-05
- 范围：设置 › 皮肤 › 倾斜高光开关；方向权限申请和拒绝提示；`src/motion/glass-tilt.ts` 写 `--g-sx`、`--g-sy`、`--g-hx`；减少动态效果时不动；宽屏（≥900px）不启用
- 读过的代码：`src/motion/glass-tilt.ts`、`src/motion/glass-ghost.ts`（startTilt 的位置）、`src/kit/components/GlassBar/GlassBarFx.tsx`（宽屏不起引擎）、`src/platform/motion-sensor.ts`、`src/features/settings/hooks/useTiltPref.ts`、`src/features/settings/ui/SkinSection.tsx`、`src/features/settings/data/local.ts`、`GlassBar.module.css` 第 57～80 行、`i18n/zh.ts` 第 154～158 行
- 取证：在 scratchpad 的独立副本里做 e2e 构建（首屏 JS 124.0 KB），wrangler pages dev 8856、假后端 9198/9199、inspector 9296；Playwright chromium（Pixel 7，375×812，授予 accelerometer/gyroscope/magnetometer）和 webkit（iPhone 15，375×812）。方向事件用脚本派发（webkit 不让 new DeviceOrientationEvent，改用带 alpha/beta/gamma 的普通 Event）；webkit 没有 requestPermission，用 addInitScript 装了一个假的，可以切同意或拒绝、记调用次数、记是否在点按里。chromium 的 requestPermission 用原生的，外面包一层计数。

## 实测结果（两个浏览器结果一致，除非注明）

| # | 场景 | 结果 |
|---|---|---|
| 1 | 默认 | 开关关、`lemo.tilt` 没有；派事件后底栏和“＋”上都没有变量 ✔ |
| 2 | webkit 拒绝 | requestPermission 调了 1 次，**在点按里**（userActivation 有效）；开关保持关、没写本机；红字提示“没有拿到方向数据的权限，倾斜高光没开。”（role=status）✔ |
| 3 | 打开 | 开关开、`lemo.tilt=1`、没有提示 ✔ |
| 3b | **打开后点“‹ 今天”回到今天页，不点底栏，直接倾斜** | **底栏和“＋”都不动**（变量没写）✘，见 T1 |
| 4 | 重载后、点底栏之前 | 不动（按设计：要等第一次点底栏） |
| 4 | 点底栏两次 | requestPermission 只调 1 次，第二次不重问 ✔；chromium 原生结果 granted |
| 4 | 左歪 γ=-35° / 右歪 γ=+35° | `--g-sx` -5.7% / 105.7%，`--g-hx` 1.00 / -1.00；平放 β=0 `--g-sy` -3.1%，竖起 β=90 -56.7%；底栏和“＋”两块一起写 ✔ |
| 4 | 收敛 | 从竖起到左歪的大跳，32 帧（60Hz 约 0.53 s）停帧，和液滴的 `--dur-drop` 0.55 s 一个量级 ✔ |
| 4 | 抖动 | ±0.3° 的随机噪声连续 1 秒：style 写入 0 次（0.05 的停帧门槛把细抖动吃掉了）✔ |
| 5 | 中途 data-rm=1 | 下一个方向事件来时清掉变量、回到默认 ✔（没有事件就保持原样，手机上事件一直有，可以接受）；关掉 data-rm 后能接着跟 ✔ |
| 6 | 设置里关掉、不重载回到今天页 | 不动、变量没写 ✔（设置页没有底栏，回来时底栏重挂、重读开关） |
| 7 | 系统 prefers-reduced-motion: reduce + 开着 | 不动 ✔ |
| 8 | 1280 宽 + 开着 | 不动（GlassBarFx 宽屏不起引擎）✔ |
| 9 | 深色 | 变量照常写；截图见 webkit-dark-right |

像素差（chromium，默认 vs 左歪 / 右歪，底栏下部截图 984×263）：左歪最大差 43、超过 8 的像素 2017 个；右歪最大差 129、超过 8 的像素 6532 个，变化主要在“＋”的亮边上，长条底栏上的那片光变化很淡。

## 必改

- **T1 打开后回到底栏不动，要再点一下底栏才开始跟（chromium、webkit 都是）。** 设置页的开关已经在点按里拿到了权限（webkit 假授权 granted、chromium 原生 granted），可是 `glass-tilt.ts` 的 `asked` 是另一份状态，底栏重挂时 `askFn()` 存在且 `asked === null`，只挂上 click 等第一次点按，所以用户刚打开开关、回到今天页晃手机，看到的是“没反应”。说明文字只说 iPhone“每次打开柠檬记后，第一次点底栏会问一次”，刚在设置里同意过的这一次不应该还要点；而且安卓 Chrome 也有 `requestPermission`（实测 `typeof` 为 function），同样要点一下才动，说明里完全没提。
  - 改法建议：设置页同意后，在这一次打开 App 里把 `glass-tilt.ts` 的“已同意”记上（motion 不能引 features 的话，用 sessionStorage 里的一个键，或 `glass-tilt.ts` 导出一个 `markTiltGranted()` 放到 platform 层转一下），底栏挂上时看到已同意就直接 listen。加一条 e2e：打开开关 → 点“‹ 今天” → 不点底栏直接派方向事件 → 变量有值。
  - `motion-sensor.ts` 注释“没有这个接口（安卓、电脑）”和 `glass-tilt.ts` 注释“别的平台不用问”与实测不符（Chromium 也有这个接口），一起改正。

## 建议

- **T2 安卓每次打开都要先点一下底栏。** Chromium 的 `requestPermission` 不在点按里调时返回 'prompt'（实测）；可以先用 `navigator.permissions.query({ name: 'accelerometer' })` 之类看一下，已经是 granted 就直接听，不用等点按。iOS 照旧。
- **T3 拒绝提示没给出路。** “没有拿到方向数据的权限，倾斜高光没开。”只说了结果。iOS 同一次打开里再点开关多半还是拒绝，可以补半句“关掉柠檬记再打开，可以再试一次”（以真机为准）。
- **T4 长条底栏上的效果很淡。** 截图里主要是“＋”的亮边在变，底栏那片光几乎看不出（左歪最大差只有 43）。默认关、只是点缀，这个取舍可以接受；真机看一眼是否“开了像没开”，必要时把底栏的 `--g-sheen` 在开着时略提一点。
- **T5 横屏没处理。** 横屏时 gamma、beta 的意义对调，高光会跟错方向；App 如果只允许竖屏可以忽略，否则按 `screen.orientation.angle` 换轴。

## 设计与可访问性

- 开关行和提醒页免打扰同一种写法：`<label>` 包文字和 `role="switch"` 的复选框，整行 315×44 都能点（开关本体 48×28），说明文字用 `aria-describedby` 挂上；拒绝提示 role=status，读屏会播报 ✔
- “皮肤”分组排在界面语言之后，只有一行，标题、卡片、说明文字层级和别的分组一致 ✔
- 减少动态效果、宽屏都不启用；减少透明效果时底栏是实色，那片光照样写变量，看不出问题。

## 分数

| 项目 | 分数 | 说明 |
|---|---|---|
| 设计 | 8 | 开关、说明、拒绝提示都清楚；T3、T4 是建议 |
| 动效 | 7.5 | 跟手、收敛、停帧、抗抖都好；T1 让第一次打开时看起来像坏了 |
| 可访问性 | 8.5 | 减少动态效果两条路径都不动、宽屏不启用、开关整行可点、提示可播报 |

**结论：不通过，必改 T1。** T1 改完、补上那条 e2e，可以只复审 T1。

截图（docs/02-设计/当前界面截图-1104/）：TILT-评审-chromium-skin-off、-chromium-skin-on、-webkit-skin-denied（设置 › 皮肤）；TILT-评审-chromium-home、-chromium-left、-chromium-right、-webkit-home、-webkit-left、-webkit-right（底栏默认、左歪、右歪）；TILT-评审-webkit-dark-right（深色右歪）。

## 复审一（2026-11-05，逐条复查上一轮意见）

取证：独立副本 e2e 构建（首屏 JS 124.4 KB），8856、假后端 9198/9199、inspector 9296；前端 B 的 tests/e2e/b2-tilt.spec.ts 加我自己的补充测试，chromium 和 webkit（iPhone 15）各跑 2 遍，2 个 worker 并行。

| 编号 | 上一轮 | 这一轮 | 证据 |
|---|---|---|---|
| T1 | 必改：设置里打开后回到底栏不动 | **已解决** | `startTilt` 挂上时先 `quietGranted`：不在点按里问一下，这次打开里同意过就直接听。b2-tilt 的 T1 用例里，假权限按真机规矩答（1 秒内有点按才同意），两种浏览器 ×2 遍全过。我另外用 chromium **原生** requestPermission 加浏览器自己的传感器授权测：设置里打开 → 点“‹ 今天” → 不点底栏，倾斜 γ=30° 时 `--g-sx`=97.7% |
| T2 | 建议：安卓每次打开都要先点一下底栏 | **已解决** | 先看 permissions 里 accelerometer、gyroscope 是不是 granted。chromium 原生测：重载后不点底栏，倾斜 γ=-30° 时 `--g-sx`=2.3%。“新打开 App 要先点底栏”的用例（假权限答 prompt、不在点按里就拒）也过 |
| T3 | 建议：拒绝提示没给出路 | **已解决** | 中文改成“……关掉柠檬记再打开，然后再打开这个开关，可以再试一次。”，见截图 TILT-评审-复审一-webkit-拒绝提示。说明文字也不再写成只有 iPhone 要问。韩文标了 REVIEW(ko)，等韩文审校，不在我的范围 |
| T4 | 建议：长条底栏上效果很淡 | 还开着 | 要真机看，前端 B 已列入真机项 |
| T5 | 建议：横屏没换轴 | **已改**，要真机核对 | `screenAxes` 按 `screen.orientation.angle` 换轴，单测管。Windows 上的 Playwright webkit 竖屏也报 angle=90，e2e 把它钉成了 0。符号方向只能真机核对，和 T4 一起看 |

代码复查：`quietGranted` 和第一次点底栏同时进行时不会重复 listen（两条路都先看 `asked`）。iOS 不在点按里调 requestPermission：这次打开里同意过的直接回 granted，没同意过的被拒，不弹窗。这和 WebKit 先看已记住的状态、再查是不是点按的顺序一致，要真机确认一次。

新建议（不挡）：
- T6 拒绝提示一句话里有三个“打开”，读着绕。可以改成“完全退出柠檬记、重新进来后，再打开这个开关试一次”。

| 项目 | 初审 | 复审一 |
|---|---|---|
| 设计 | 8 | **8.5** |
| 动效 | 7.5 | **8.5** |
| 可访问性 | 8.5 | **8.5** |

**结论：通过。** 还要真机看 T4、T5，以及 iOS 不在点按里调用时回不回 granted。
