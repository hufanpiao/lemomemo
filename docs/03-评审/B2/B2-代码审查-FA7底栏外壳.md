# B2 代码审查：FA-7 底栏外壳

- 审查员：独立代码审查员（兼看安全；只读，默认不通过，10 分制，8 分及以上通过）。设计、动效另有评审员，这里只看代码正确性、安全、首屏、测试。
- 日期：2026-11-05
- 对象（前端 B，工作区未提交）：
  - `src/kit/components/GlassBar/`（`GlassBar.tsx`、`GlassBar.module.css`、`__tests__/GlassBar.test.tsx`）
  - `src/app/App.tsx` 按路由挂底栏、“＋”按页新建
  - `TodosPage` 去掉右上“＋”
  - `TodayPage` 头像（`useMeInitial.ts`、`me-initial.test.ts`）
  - `NotesPage`“即将推出”
  - `src/styles/base.css` 的 `::view-transition`、`src/motion/vt.ts` 的 `VT_FIXED`
  - 8 个新文案键
  - `tests/e2e/b2-tabbar.spec.ts`、`b1-settings.spec.ts`
- 验证都在 scratchpad 独立副本里做（node_modules 联接；端口 8852、inspector 9292、假后端 9192/9193），做完拆联接、删副本，确认端口没人在听；主仓没改任何源码。

## 一、结论先说

**通过，8.0 分（刚到线）。** 没有高问题。有 1 条中问题（M1：头像首字遇到看不见的字符会变成空圈，修起来只要几行），建议合入前改掉。第 ④ 项 webkit 的 CSP 问题已查到来源：WebKit 内核只要新建 `<select>` 就报 style-src-attr，和底栏、doc-locale 分包都没有直接关系。

## 二、逐项

### ① 首屏：149.4 KB，属实；能挪的不多

副本里 chromium 跑一次 `b2-first-screen-budget.spec.ts`，149.4 KB 通过（今天页出现在 763 ms），离硬线还剩 0.6 KB。构建自带的静态闭包口径是 106.2 KB。下载明细如下：

| 时刻 | 下载的块 |
|---|---|
| 19 ms | 入口：main 23.6 KB、`doc-locale` 71.1 KB、jsx-runtime 3.3 KB、sign-out 5.1 KB 等 |
| 142 ms | 告知页关口一组，约 7.3 KB |
| 450 ms | 今天页一组：TodayPage 3.8 KB、components 17.5 KB、useToday 3.9 KB、UndoToast 0.6 KB 等 |
| 528 ms | 错过提醒一组：MissedReminders 1.5 KB、remind-list 2.0 KB、Bell、Remind.module 等，约 5.6 KB |

- **底栏外壳本身在 main 里**：`tabbar`、`jelly` 都在 main 块中，在首屏是对的，底栏首屏就要画出来。外壳只有 4 个链接、一个按钮、一个液滴，按需加载没有意义。
- **方案里的“内容副本、自动深浅、帧循环”还没进来**，以后必须放在 `afterAppPainted` 之后按需加载。建议现在就在 `first-paint-graph` 加一条断言把它钉住（见 L3）。
- **能挪出首屏的，按收益排：**
  1. 错过提醒那组约 5.6 KB，在今天页出现之前就开始下载。这是设计复审 J1 定的“首屏直接画出错过行”，要挪得负责人点头，我不建议自行改；
  2. `UndoToast` 0.6 KB 被今天页静态引用，只在删除后才用到，可以改成 `lazy`；
  3. 告知页关口那组里的写入件（write、setting-patch、sync-errors，约 1.6 KB），已同意过告知的用户首屏用不到，可以查查能不能按需加载。
- 第 2、3 条合计约 2 KB，可以把余量拉回 2.5 KB 左右，给后面的内容副本和帧循环留位置。

### ② useMeInitial 取首字

- **做法是对的**：先 `trim`，再用 `Intl.Segmenter` 按字素取第一个。用同一算法在 Node 实测：
  - 中文、韩文完整音节、NFD 分解的韩文（ᄀ+ᅡ+ᆨ 取成“각”）、国旗、肤色表情、ZWJ 组合表情（👩U+200D💻）、带变体选择符的 ❤️，都整字取出；
  - 全角空格、不换行空格、换行开头都会被 trim 掉。
- **测试源码**：之前 `me-initial.test.ts` 里原样出现的 U+200D 已改成转义写法 `U+200D`。
- **M1（中）**：名字开头是看不见的字符时，取出来的“第一个字”就是它本身，头像变成空圈（还能点，但看不出是设置入口）。实测会这样的有：
  - 零宽空格 U+200B、零宽连接符 U+200D（不会被 trim 掉）；
  - 方向控制符 U+202E；
  - 单独的组合附加符 U+0301；
  - 标签字符 U+E0041；
  - 整个名字只有零宽字符时，返回的也是 U+200B，不是 null。

  名字是用户自己填的，复制粘贴时常带上零宽字符。手机上设置只有这一个入口，所以列为中。

  建议：跳过开头的 `\p{Cc}\p{Cf}\p{M}\p{Z}`；如果第一个字素不含 `\p{L}`、`\p{N}`、`\p{Extended_Pictographic}`、`\p{Regional_Indicator}` 中的任何一种，就返回 null（画人形）。测试补上述 5 种输入。
- **安全**：名字作为 React 文本渲染，不经 innerHTML，没有注入面。U+202E 只影响头像里那一个字，不会串到别处。
- **低**：`useMeInitial` 读的是启动时缓存的 `getBoot().profile`，不跟着状态变。第一次登录还没缓存时一直是人形，要到下次冷启动才出字。现在 App 里没有改名的入口，影响不大；以后加了改名，要换成订阅式的读法。

### ③ 路由、选中态、“＋”的目标

- `App.tsx:59` 的 `TAB_OF` 把 today、calendar、cal（月历子页也算日历）、todos、notes 映射到页签，其余路由（设置、编辑页等）不画底栏。
- 页签是 `<a href="#/…">`：原生 hash 跳转，前进后退走路由的 hashchange；选中项 `aria-current="page"`。
- “＋”的目标：
  - 待办页 → `navigate('todo', 'new')`；
  - 今天、日历 → `navigate('event', 'new')`；
  - 随手记直接 `<GlassBar active="notes" />`，不传 `add`，不出“＋”。
  - 和负责人 11-05 定的一致。
- 液滴位置用 CSSOM 的 `style.setProperty('--i')` 写，不走 React 的 style 属性，避开 CSP 的 style-src-attr，做法对。
- `::view-transition { pointer-events: none }` 让切页动画期间的点按落到新页面；底栏、“＋”切页时不淡入淡出，名字已登记进 `VT_FIXED`。
- 页面底部本来就留了 140px，被底栏挡住的内容能滚出来。
- **L1（低）**：route → 页签、“＋”目标这张映射表没有单元测试，只有 e2e 管：
  - `cal` 子页的选中态、日历页“＋”的目标，e2e 都没测；
  - “＋”那条 e2e 在 webkit 上整条标了 `test.fail`，webkit 上“＋”跳错页也看不出来。

  建议把 `TabBar` 的映射抽成纯函数 `tabOf(route)` / `addOf(tab)`，补单元测试；e2e 把 CSP 断言和导航断言分开，见下面第 ④ 项的建议。
- 新建日程不带日历页当前选中的日期（总是 `event/new`）。这是产品行为，如果想“在选中那天新建”，需要设计另定，这里只提一句。

### ④ webkit 的 test.fail：来源已查明

**结论：WebKit 内核本身的行为。`document.createElement('select')` 就会报一条 style-src-attr。和底栏无关，也不是 doc-locale 这个模块的问题。**

证据：

1. **“doc-locale 分包”其实是公共大块。** 产物里的 `doc-locale-*.js` 压缩前约 229 KB，首屏 gzip 71.1 KB，被 28 个入口和块引用，里面主要是 React DOM 和大量共用代码。Rollup 按其中一个模块给它起了名字，所以“来源 doc-locale”只说明违规发生在公共代码里，不指向 `platform/doc-locale.ts`。
2. **违规的确切位置。** 在副本里用 webkit 探针抓 `securitypolicyviolation`：`sourceFile=doc-locale-*.js`、第 9 行第 89015 列，target 是 document，sample 为空。对照产物，这一列正是 React DOM `createInstance` 里 `ownerDocument.createElement("select")` 那一句。待办、日程编辑页都有原生 `<Select>`（`TodoEditPage.tsx:155、166`，`EventEditPage.tsx:154、164、176`）。
3. **减少动态效果时一样报**，所以和 View Transition 无关。
4. **最小复现。** 在一个只有 `<meta http-equiv="Content-Security-Policy" content="style-src 'self'">` 的空白页里：

   | 操作 | Playwright 的 WebKit | Chromium |
   |---|---|---|
   | `document.createElement('select')`（不挂到页面上） | 报 1 条 style-src-attr | 0 条 |
   | 再建一个带 option 的 select 并挂上 | 再报 1 条 | 0 条 |
   | `createElement('input')` | 0 条 | 0 条 |

   推测是 WebKit 给 select 建内部 user-agent shadow 树时用了带 style 属性的元素，被页面 CSP 算了进去。

排查和修法方向（交给修这个问题的人）：

- **先在真 iPhone Safari 上确认。** 用 Web Inspector 连上，打开编辑页看控制台有没有这条 CSP 报错，下拉框外观、展开是否正常。
  - 只是报错、功能正常：属于内核误报，给 WebKit 提 bug（附上面的最小复现）。
  - 被拦后外观或展开出问题：再考虑改控件。
- **为什么“直接打开 #/todo/new 不报”？** 同样会建 select，按理也该报。可能是探针或 csp-fixture 的监听挂得比首次渲染晚，或者直接打开时这批 select 由别的路径建出来。建议用 `addInitScript` 最早挂上监听再测一次。我的推断是两种打开方式都会报，只是测法没抓到。
- **e2e 的处理。** 不建议整条用例标 `test.fail`，那样会把这条里的导航断言一起放过。建议：
  - 导航和“＋”目标的断言照常跑；
  - CSP 检查对 webkit 只放过“style-src-attr、sample 为空、target 是 document，而且就发生在建 select 的那一步”这一种特征，其余违规照样失败；
  - 再加一条最小复现用例（上面那个空白页）标 `test.fail`，内核修好后它会变红，提醒去掉这条放行。
- **备选。** 如果真机上确实影响外观或行为，把原生 `<select>` 换成自绘的列表弹层（Popover 已有）。代价是要自己做无障碍和键盘支持，属于产品层决定。

## 三、测试与检查

- 副本里 GlassBar、today、todos、notes、app、motion、auth、tests/shared、first-paint-graph 共 119 个文件，1140 条通过、1 条跳过。
- GlassBar 的单元测试覆盖：4 个页签都是链接、只有选中项带 aria-current、韩文页签、“＋”传了才出、液滴 `--i` 位置、换页签才放“果冻”、按住放大和还原、两种减少动态效果、减少透明效果时的实色、切页名字已登记。

## 四、问题表

| 编号 | 严重程度 | 文件:行 | 问题 | 建议 |
|---|---|---|---|---|
| M1 | 中 | `src/features/today/hooks/useMeInitial.ts:6-12` | 开头是零宽字符、方向控制符、组合附加符、标签字符时取出看不见的字，头像变空圈；名字全是零宽字符时也不返回 null | 跳过开头的 `\p{Cc}\p{Cf}\p{M}\p{Z}`；第一个字素不是字母、数字、表情、国旗时返回 null；补 5 种用例 |
| L1 | 低 | `src/app/App.tsx:59-67`；`tests/e2e/b2-tabbar.spec.ts:39` | route → 页签、“＋”目标没有单元测试；cal 子页和日历页“＋”没测；webkit 上整条 `test.fail` 把导航断言一起放过 | 抽 `tabOf`、`addOf` 纯函数补单元测试；e2e 把 CSP 放行收窄到“select 内核误报”这一种特征 |
| L2 | 低 | `src/features/today/ui/TodayPage.tsx:28` | `UndoToast` 静态引用进了首屏（0.6 KB），只在删除后才用 | 改成 `lazy`；连同告知页关口的写入件一起看，约可回收 2 KB |
| L3 | 低 | `tests/build/first-paint-graph.test.ts` | 方案里后面要做的内容副本、帧循环还没有“不许进首屏”的守护 | 现在就加：GlassBar 的静态闭包不许到 `GlassBar/engine*`（或约定的目录），e2e 首屏预算照旧兜底 |
| L4 | 低 | `src/features/today/hooks/useMeInitial.ts:15` | 读启动时缓存的 profile，第一次登录到下次冷启动之间一直是人形 | 现在可以接受；加改名入口时改成订阅式读法 |

## 五、评分

| 维度 | 分数 | 说明 |
|---|---|---|
| 正确性 | 8 | 路由、选中态、“＋”目标、随手记都对；首字取法对常见文字正确，但看不见的字符没处理（M1） |
| 安全 | 9 | 不走内联 style、不用 innerHTML；名字只作文本；CSP 违规已查明是内核行为 |
| 首屏 | 7.5 | 149.4 KB 合规但只剩 0.6 KB；外壳本身没法再省；有约 2 KB 可回收（L2） |
| 测试 | 7.5 | GlassBar 单测扎实；App 的映射表只靠 e2e，webkit 整条 `test.fail` 偏宽（L1） |
| **总分** | **8.0** | **通过（刚到线）** |

## 六、结论

**通过（8.0 分）。** 建议合入前改掉 M1（几行代码加 5 条用例）。L2、L3 最好在做内容副本之前完成，否则首屏会先撞线。webkit 的 CSP 问题是 WebKit 新建 `<select>` 时内核自己报的，排查方向见第 ④ 项。

## 七、复审（快照时刻 2026-11-05 12:49:59）

以这个时刻复制到 scratchpad 的工作区快照为准。前端 B 之后还在改 GlassBar（挪出首屏、侧栏），那部分不在本次范围。做法同前：node_modules 联接；端口 8853、inspector 9293、假后端 9192/9193；做完拆联接、删副本，端口已确认释放；主仓没改源码，也没 git add。

### 上一轮问题

| 编号 | 修法 | 复核 | 结论 |
|---|---|---|---|
| M1 | `useMeInitial.ts` 先去掉开头的 `\p{White_Space}\p{Cf}\p{M}`；第一个字素不是字母、数字、表情、国旗时返回 null | 测试覆盖 5 种不可见字符、全是不可见字符、标点开头、国旗、数字。变异“改回只 trim”：红 3 条以上 | 已解决 |
| L1 | 映射抽成 `src/app/tab-of.ts` 的 `tabBarFor`，`tab-of.test.ts` 覆盖四页、`cal` 子页、其余每条路由都没有底栏；webkit 不再整条 `test.fail`，`csp-fixture.ts` 只放过“webkit、style-src-attr、blocked=inline、来源本站 /app/assets/、条数不超过挂进文档的 select 个数”这一种；最小复现单独放在 `csp-webkit-select.spec.ts`（标 `test.fail`） | 变异“`cal` 改坏”：红。另做了一个 e2e 探针：webkit 编辑页（有 select、放行规则生效）上再插一个带 `style` 属性的元素，chromium、webkit 都判失败，说明放行规则不会吞掉真的违规 | 已解决 |
| L3 | `first-paint-graph` 加 glass-ghost 守护：main 和首屏名单的静态闭包都到不了 `motion/glass-ghost.ts`，自带变异（GlassBar 静态引它）能拦住；`NOT_FIRST_PAINT` 也登记了原因 | 读码，用例通过 | 已解决 |
| L2、L4 | 没动 | — | 照旧是低建议 |

### 设计评审引出的结构改动

- **D1（底栏挪出页面的 Suspense）**：底栏有自己的 ErrorBoundary 和 Suspense；第一个 `main[data-feature]` 出现以前不画（用 `whenOwnPage`），出现以后一直画。液滴先按“从哪页点到哪页”走，路由一变就作废（在渲染时 setState 派生状态，是 React 认可的写法）。冷启动不会出现“底栏比页面先出来”。
- **L1（果冻改用 WAAPI，`glass-ghost.ts` 的 `playGel`）**：
  - 连点时先取当前 scale，`cancel()` 旧动画再接着放；减少动态效果时直接返回、不放；
  - 没有 WAAPI（或引擎还没下载到）时退回 CSS 动画换 key 重挂。
  - 正确。
- **键盘弹起藏底栏**：`platform/viewport.ts` 在 `afterAppPainted` 之后才下载，卸载时有 `off` 标志和 `stop()`；`tabbar-app.test.tsx` 通过。
- **内容副本 `makeCopy`（低，新增 L5）**：
  - 已有的处理：克隆后去掉 id、testid、tabindex、href，表单控件设 disabled，外层 `aria-hidden`、`inert`，`[data-private]`、隐私记区域不复制。
  - 漏掉的一点：没去掉输入框的 `name`。同名的 `<input type="radio">` 不论是否 disabled 都算同一组，克隆出一个选中的副本会把原来那个挤成未选中。
  - 现在四个有底栏的页都没有带 name 的单选框（唯一一处在设置页 `CalendarSettings`），所以只是隐患。
  - 建议在 `makeCopy` 里一并 `removeAttribute('name')`、`removeAttribute('form')`。

### 首屏（实测）

`b2-first-screen-budget.spec.ts` 跑了 chromium、webkit 各 3 次，**6 次都是 149.9 KB**，全部 ≤ 150 KB，余量只有 0.1 KB。前端 B 正在把 GlassBar 挪出首屏，那之后要重测。`b2-tabbar.spec.ts`、`csp-webkit-select.spec.ts`、`b1-settings.spec.ts` 共 33 条通过，`csp-webkit-select` 在 webkit 上按预期失败。

### 顺带发现（不计入本项）

前端 A 新加的 `src/motion/__tests__/fake-frames.test.tsx`（D2 回归）单独跑 3 次都过，但和 97 个文件一起满载并行跑 3 次，红了 1 次（toast“3000 ms 动画时间内播完”）。这条测试自己就偶发失败，转给前端 A：看看是不是被 vitest 默认 5 秒超时卡住，可以加大超时，或者少推几帧。

### 复审结论

**8.0 → 8.5，通过。没有必改项。** 低建议：

- L5：`makeCopy` 去掉 `name`、`form`；
- L2：`UndoToast` 改按需加载；
- L4：头像改订阅式读法。

首屏只剩 0.1 KB，GlassBar 挪出首屏之后必须重测。

## 八、复审测试设施（2026-11-05 13:20:22 快照：csp-fixture、fake-frames）

在独立副本 cr-r9 里核对。e2e 用端口 8857 和 inspector 9297，但我按旧约定把假后端开在了 9192、9193，挡住了前端 B 的 e2e。接到主持人通知后，我已经停掉假后端（PID 47872）和 wrangler，并确认这些端口没人在听。以后审查员的假后端只用 9196～9199。

### 8.1 tests/e2e/csp-fixture.ts：会不会吞掉页面自己的真违规

我在副本里加了一个探针用例，用 webkit 跑了 5 种情形，跑完已删。结果：

| 情形 | 新违规 | 被放过 | 判失败 |
|---|---|---|---|
| 建 1 个 select，再对 div 做 setAttribute('style') | 2 | 1（select 那条） | 1 |
| 建 5 个 select（额度是 5），再用 innerHTML 写带 style 的元素 | 6 | 5 | 1 |
| 自定义元素在构造函数里设 style（构造函数在 createElement 里面同步执行） | 1 | 0 | 1 |
| 建 select 以后，在 select 上设 style | 2 | 1 | 1 |
| 用 `Document.prototype.createElement.call` 建 select，再设 style | 2 | 1 | 1 |

- 结论：真违规的来源是页面脚本（这里是 evaluate，sourceFile 为空），永远不会等于注入脚本的 URL `web-inspector://bootstrap.js`。所以事件那一路只放过 createElement 包装函数里那一条内核误报，即使额度富余，也吞不掉真违规。
- 控制台那一路按建过的 select 个数扣，文字是通用的“Refused to apply a stylesheet …”，确实可能扣掉一条真违规的控制台文字。但同一条真违规一定也有事件，会由事件那一路判失败，所以整体不会漏判。
- 失败方向都是偏严：如果用 createElementNS 或 HTML 解析建 select，不会计数，会多报，不会少报；如果从调用栈取不到 URL，own 为空，额度为 0，什么都不放过。
- csp-webkit-select.spec.ts 和探针用例在 webkit 下 7 条全部通过。
- 4 个 worker、每条重复 3 次的压力复跑，因为端口冲突被我中途停掉了，没有拿到结果，这一项没有核对。

### 8.2 src/motion/__tests__/fake-frames.test.tsx：真实 rAF 改成攒着不放

- 单独跑 3 次全绿；满载全量 vitest（加了 --exclude gen-tauri-key）时它也是绿的。全量里红的是 publish-run 那几条、check-arch 那几条，原因是副本不是 git 仓库，以及 fork-suffix 的 A20（别人正在改），都和这一项无关。
- 变异：把 fake-frames.ts:19 的 `processFrame()` 注释掉，toast、sheet、page 三条都红。这个用例本来要防的回归，能稳定拦住。
- 自检 `slow.frames() - before === 0` 在用例运行期间必然成立，因为攒着的回调只在 afterEach 里放。它防不住什么，只能当作说明。不影响判据，记为低。

### 8.3 问题表

| 编号 | 严重程度 | 文件:行 | 问题 | 建议 |
|---|---|---|---|---|
| L9 | 低 | tests/e2e/csp-fixture.ts:111 | 控制台那一路按 select 个数扣的是通用文字，会顺带扣掉真违规的控制台文字（事件那一路兜底，不会漏判） | 在注释里写明“控制台那一路靠事件兜底”；或者只在事件那一路也确实标出过 select 违规时才扣 |
| L10 | 低 | src/motion/__tests__/fake-frames.test.tsx:67 | 自检在运行期间恒为真，起不到检查作用 | 改成断言 `held.size > 0`（Motion 确实请求过真实帧，又被攒住了），这样才能证明“没有真实帧也播完了” |

### 8.4 评分与结论

csp-fixture：**8.5，通过**；fake-frames：**8.5，通过**。**必改：无**。建议 L9、L10；4 个 worker 的压力复跑请主持人另排时间，用 9196～9199 端口重跑。

### 8.5 补跑：4 个 worker 并发、每条重复 3 次（2026-11-05 13:40:30 快照）

- 在独立副本 cr-r11 里跑。端口：wrangler 8858、inspector 9298、假后端 9196 和 9197。
- 范围：webkit 下的 b2-tabbar.spec.ts、csp-webkit-select.spec.ts，以及所有打开 todo/new 编辑页的用例（这些页面会建 select）。
- 结果：`--workers=4 --repeat-each=3`，**30 条全部通过，没有 flaky**，用时 1.2 分钟。之前 4 并发下的偶发失败没有再出现。
- 跑完已停掉相关进程，确认 9196～9199、8858、9298 都没有程序在监听，副本 cr-r11 也已删除。
- 8.4 的结论不变：csp-fixture 8.5 通过，必改无。

## 九、复审：对比度例外名单（accepted）、L5 makeCopy（2026-11-05 13:44:03 快照）

变异都在独立副本 cr-r12 里做，做完已删。

### 9.1 check_contrast 的 accepted 名单

- **名单外的不达标照样报错，这一点成立。** 真仓库现在 4 套皮肤 × 74 项，共算 279 次：不达标 0 次，已接受的例外 8 次。我在副本里把深色玻璃的 `--g-tint` 从 .44 降到 .20，名单不动，结果 accepted 用例变红；脚本本身也会把这一项判成“比 floor 更差”，报 1。名单写错（已经达标、皮肤或项不存在、缺字段、重复）报 2，这几种情形都有用例。
- **名单能被悄悄放宽，这是漏洞。** 用例只钉了“条数 = 8、decided 含 11-05、reason 长度大于 5”，没有钉住每条的 theme、id、floor；脚本也只检查“精确值 ≥ floor”，不检查 floor 是不是接受时的那个值。两个变异都没被拦住：
  - C1：把 8 条 floor 全改成 1.0，71 条用例全过，脚本报 0；
  - C2：深色 `--g-tint` 降到 .20（对比度变成 1.3586），同时把 floor 改成 1.0，用例全过，脚本仍然把它列为“已接受的例外”。
  - 同理，把名单里某一条换成另一项新的不达标、保持 8 条不变，也拦不住。
- **4 条 g-ad 例外不是同一个决定。** 负责人 11-05 的决定写的是“深色 --g-tint 保持 0.44”，可 8 条里有 4 条是浅色皮肤的 g-ad 项（g-ad-floor、g-ad-halo，glass 和 simple 两套各 2 条），算的是 `--g-ad-tint` 和 `--g-halo`。其中 g-ad-halo 是正文，对比度 1.05，reason 里写的是“实际不叠这层”。如果实际真的不叠这层，应该改清单里这一项的定义，不该靠例外放过。

### 9.2 L5 makeCopy（src/motion/glass-ghost.ts:67）

- 去掉的属性：id、name、form、data-testid、data-ghost、tabindex、链接的 href；表单控件和按钮加 disabled。整层副本 aria-hidden 加 inert，pointer-events: none。
- 新用例核对了三件事：同名单选框的副本不会挤掉原件的选中状态；副本的 `.form` 是 null；副本不会归到原表单的 elements 里。
- 还留着的、指向 id 的属性：label 的 for、aria-labelledby（比如 DayList 的 `aria-labelledby="cal-day-title"`）、input 的 list 等。它们都指回原件。因为整层 inert 加 aria-hidden，不会被点到，也不会被读屏读到，没有实际影响。
- 有副作用的元素：video、audio 的 autoplay，iframe，autofocus。会被复制的 9 处 data-ghost（今天页、待办、日历的行和卡片）里，src 中都没有 video、audio、iframe、autoPlay、autoFocus，所以现在没有影响。
- 测试上的隐患（低）：副本还带着 data-date、data-state、data-done 这些属性。tests/e2e/b2-tabbar.spec.ts:53-54 用 `button[data-date]:not([inert])` 想排除副本，但 inert 加在副本层的父元素上，副本按钮本身没有这个属性，所以副本照样能被选中。现在靠副本排在原件后面、用了 `.first()`、`.nth(10)` 才碰巧没出事。

### 9.3 问题表

| 编号 | 严重程度 | 文件:行 | 问题 | 建议 |
|---|---|---|---|---|
| M5 | 中 | tests/build/check-contrast-accepted.test.ts:101；build/check_contrast.py:537 | 名单只钉了条数，floor 可以被悄悄调低，也可以换掉其中一条；变异 C1、C2 都没被拦住 | ① 用例钉死 8 条的 (theme, id, floor) 原值；② 脚本要求 floor 等于精确值向下截断到 4 位，不相等就报 2（改好一点也要求更新 floor，只能往上收紧） |
| Q1 | 待负责人确认 | build/contrast-pairs.json accepted 里的 g-ad-floor、g-ad-halo（glass-light、simple-light） | 这 4 条借用了“深色 --g-tint 0.44”的决定；g-ad-halo 的 reason 写“实际不叠这层” | 请负责人确认这 4 条是否也在接受范围内；g-ad-halo 建议改清单定义，不靠例外放过 |
| L11 | 低 | tests/e2e/b2-tabbar.spec.ts:53-54 | `:not([inert])` 排除不了副本（inert 在副本层的父元素上） | 改成 `:not([inert] *)`，或者把选择器限定在 main 里面 |
| L12 | 低 | src/motion/glass-ghost.ts:69 | 没处理 autoplay、iframe、autofocus（现在被复制的行里都没有） | 加一条用例断言 data-ghost 的行里没有这些元素，或者在 makeCopy 里一并去掉 autoplay、autofocus |

### 9.4 评分与结论

- accepted 名单：**7.5，不通过**。名单外的不达标照样会报错，但名单本身能被悄悄放宽，正好是这次要看的重点。**必改：M5**。Q1 交负责人确认。
- L5 makeCopy：**9.0，通过**。建议 L11、L12。

## 十、复审：M5、L11、Q1（2026-11-05 13:51:34 快照）

核对在独立副本 cr-r13 里做，做完已删。

### 10.1 M5：对比度例外名单

- 脚本（build/check_contrast.py:537-541）：floor 必须正好等于现在的精确值向下截断到 4 位，误差超过 1e-9 就报 2。
- 用例：钉死了 8 条的 (theme, id, floor)；另外新增 3 条，分别核对 floor 写成 1.0、floor 比实际高、floor 没截断，这三种都要报 2。
- 基线：73 条全过；脚本报不达标 0、已接受的例外 8。
- 变异 5 个，全部被拦住：

| 变异 | 结果 |
|---|---|
| N1：8 条 floor 全改成 1.0 | 用例红 13 条，脚本退出码 2 |
| N2：一条 floor 写宽 0.0001 | 用例红 13 条，脚本退出码 2 |
| N3：一条 floor 写高 0.0001（相当于四舍五入） | 用例红 13 条，脚本退出码 2 |
| N4：脚本里去掉 floor 核对 | 用例红 3 条（脚本此时退出码 0，靠用例拦住） |
| N5：深色 `--g-tint` 降到 .20，同时把 floor 改成新的值 | 用例红 13 条，脚本退出码 2（同一层颜色的另一项 floor 也对不上了） |

- 我第九节说的“悄悄调低 floor”和“换掉其中一条”，现在都关上了。

### 10.2 Q1：g-ad-halo

- 前端 B 说的属实：GlassBar.module.css:112-118 在 `.bar[data-ad='dark']` 里把 `--g-halo` 换成了 `--g-ad-tint`，字的柔光（:134 的 text-shadow）用的就是深色玻璃那层颜色。
- 清单里这一项已经按实际画法改成 bg=--g-ad-tint，现在的对比度是 2.4574，正文要求 4.5，还是不达标；它仍在原来的 8 项里，名单没有扩大。
- 还剩一个问题：负责人 11-05 的决定写的是“深色 --g-tint 保持 0.44”，而这 4 条 g-ad 例外（浅色皮肤）算的是 `--g-ad-tint`。两者取值相同（都是 rgba(30,31,36,.44)），reason 里也写了“同一取舍”，但 decided 没有点名 g-ad。**请主持人跟负责人确认一句**，这一条不影响打分。

### 10.3 L11

tests/e2e/b2-tabbar.spec.ts:53-58 现在把日期按钮限定在 `main[data-feature="calendar"]` 里找（CalendarPage.tsx:169 有这个标记），副本在 nav 的副本层里，选不到了。e2e 我没有重跑，前端 B 说两个浏览器各跑 3 次都通过。

### 10.4 评分与结论

- accepted 名单：**9.0，通过**（第九节是 7.5）。M5 已关；Q1 只剩向负责人确认一句。
- L11：已关。

## 十一、复审：L9、L10 和 fake-frames 偶发修复（2026-11-05 14:28:17 快照）

在独立副本 cr-r14 里核对，做完已删。

### 11.1 L9、L10

- **L9 已关**：csp-fixture.ts:110 补了注释，说明控制台那一路可能顺带扣掉同样文字的真违规，但真违规的事件那一路照样会判失败。
- **L10 已关**：fake-frames.test.tsx 新加了断言 `slow.asked() - askedBefore > 0`，证明 Motion 确实请求过真实帧、又被攒住了，原来那条“真实帧为 0”的自检因此有了意义。

### 11.2 step() 每帧后多等一次 setImmediate：会不会掩盖真问题

- **道理上讲得通**：在浏览器里，onAnimationComplete 里 setState 触发的重画由 React 调度器排队，总在下一帧之前跑完。这里在每帧之后等一次真实的 setImmediate，就是把顺序固定成和浏览器一样。FAKE 名单里没有 setImmediate，所以这一等不会被假时钟吞掉。
- **4 个变异都照样变红**，修复没有把真问题盖住：
  - A2：Appear 去掉 `transitionEnd: none`，src/motion 红 6 条；
  - A3：settled 分支不再清 transform，红 6 条；
  - A4：保留 setImmediate、去掉 processFrame，红 3 条。等一次宏任务不能替代推帧；
  - 另外，恢复页 L3 的变异也拦住了（见账号信记录第九节）。
- 前端 A 说“40 份并发跑 480 次 0 次红”，我没有重复这个实验。

### 11.3 压力下另外查出来的偶发失败（不是这次的改动引入的）

我在副本里用 12 份、4 份并发跑 src/motion：12 份并发里红了 4 份，4 份并发里红了 1 份。红的都是**没用 fake-frames、按真实时间等的用例**：

- features-async.test.tsx:107：用 `wait(12)` 等 6 次，按墙钟取样“退场在播，还没卸载”。机器一忙，退场在取样期间就已经播完，断言失败；
- appear-exit-from.test.tsx：“停稳后关是原位到终点……”这一条用 `wait(100)`、`wait(30)` 按真实时间等。

src/motion 下还有 7 个用例文件没用 fake-frames（appear-exit-from、appear-list、features-async、Pressable、Pressable-link-attrs、reduced-motion、use-hold-view）。其中按墙钟取样动画中间状态的，CI 一忙还会偶发变红。

### 11.4 问题表

| 编号 | 严重程度 | 文件:行 | 问题 | 建议 |
|---|---|---|---|---|
| M6 | 中 | src/motion/__tests__/features-async.test.tsx:96-107；appear-exit-from.test.tsx:52-54 | 按真实时间取样动画中途的状态，并发时偶发变红（12 份并发红 4 份，4 份并发红 1 份） | 改用 fake-frames 的 step、until 按动画时间推进；不能整体改的，至少把“播放途中”的取样换成按动画时间推进 |

### 11.5 评分与结论

- L9、L10、setImmediate 修复：**8.5，通过**。修复没有掩盖真问题，4 个变异都照样能拦住。
- **必改：无**（M6 是以前就有的问题，不是这次引入的）。M6 建议排进下一批；如果这批提交前 CI 又在这两个文件上红，按 M6 处理。

## 十二、代码审查：R4 过渡中代点、R5 像素门槛、D5 宽屏侧栏及 S1～S3、--dock-bottom 宽屏值（2026-11-05 14:54:32 快照）

在独立副本 cr-r16 里核对。e2e 用的端口：wrangler 8858、inspector 9298、假后端 9196 和 9197。跑完已删副本，确认这些端口都没人在听。

### 12.1 首屏

- 按页面时钟口径实测（b2-first-screen-budget.spec.ts，1 个 worker）：chromium 和 webkit 都是 **149.7 KB**，上限 150 KB，只剩 0.3 KB。check_size 按静态闭包口径算是 124.0 KB。
- 宽屏判断（useSyncExternalStore + matchMedia）和设置入口都在外壳里，是首屏要的；模糊带、副本、代点在 GlassBarFx 里，首屏画完以后才下载。
- 4 个 worker 并发时同一组用例红了 6 条，1 个 worker 时 24 条全过。红的原因是并发太重：chromium 今天页 11.5 秒才出来，于是首屏后才该下的块都被算进了“首屏”（257.7 KB、带 zod）；底栏过渡用例 5 秒内等不到元素；R4 那条采样只有 19 次，门槛是 20。这些都是机器忙造成的，不是产品问题，但首屏预算和过渡用例对负载很敏感（见 L13）。

### 12.2 分包失败时的兜底

- GlassBarFx 下不来时：页签、“＋”、液滴、设置入口都在外壳里，照常能用；只是没有模糊带、果冻和代点（过渡中点按会被吞），材质用后备色。glass-ghost 下不来时 GlassBarFx 自己有 catch。
- 变异 G6：把外壳 `import('./GlassBarFx.tsx')` 后面的 `.catch` 去掉，src/app、src/kit 和首屏图的 419 条用例照样全过。**没有一条用例模拟“首屏后部分下载失败”**，兜底没人守着（见 L14）。

### 12.3 代点会不会误触（GlassBarFx.tsx:56-67）

- 只在点按的目标正好是 `<html>`、底栏没被键盘藏起来、坐标落在页签或“＋”的矩形里时才代点；点在别处、目标不是 `<html>` 都不管，单元用例覆盖了这几种。
- 我用探针在 chromium、webkit 里各试了一遍：#root 加 inert 时，在底栏位置点按，目标是 `BODY`，不是 `HTML`；body 不满屏时也一样。所以退出确认屏这类给 #root 加 inert 的场景，代点不会被触发。
- 但同一个探针也表明：**inert 里的 `<a>` 调 `.click()` 照样会跳转**。万一切页过渡进行中正好有东西把 #root 设成 inert（比如过渡中途弹出退出确认屏），代点会绕过 inert。概率很低，加一个判断就能堵上（见 L15）。
- 变异：
  - G1：去掉“目标是 html”的判断，用例红；
  - G3：坐标只比上边，用例红；
  - G4：宽屏不调整 DOM 顺序，用例红；
  - G5：外壳去掉设置入口，红 4 条；
  - **G2：去掉“键盘弹着不代点”，用例全过，没拦住**（见 L16）。

### 12.4 其他

- R5：b2-tabbar-transition.spec.ts 把底栏和“＋”分开比；只数“画着”和“没画”明显不同的像素，这些像素里更像“没画”的超过 10% 就判失败，能分辨的像素至少要 200 个。门槛和注释一致，单 worker 下通过。
- S3 hover：只在 `(width >= 900px) and (hover: hover)` 时生效（GlassBar.module.css:363），触屏上不会卡在 hover 状态。
- --dock-bottom 宽屏值：base.css:34-37 在 `(width >= 900px)` 下改成 `max(safe-area + 24px, var(--kb))`，保留了键盘那一项，断点和侧栏一致。
- matchMedia 的范围写法 `(width >= 900px)` 和 CSS 的写法一样；不支持这种写法的老浏览器，JS 和 CSS 一起退回窄屏，两边不会对不上。

### 12.5 问题表

| 编号 | 严重程度 | 文件:行 | 问题 | 建议 |
|---|---|---|---|---|
| L13 | 低 | tests/e2e/b2-first-screen-budget.spec.ts；b2-tabbar-transition.spec.ts:119 | 4 个 worker 并发时会红（今天页出现得晚，首屏后的块被算进首屏；R4 采样只有 19 次，门槛是 20） | 首屏预算这条单独串行跑（`test.describe.configure({ mode: 'serial' })`，或者单独放一个 project）；R4 的采样次数按时间算，不按固定次数 |
| L14 | 低 | src/kit/components/GlassBar/GlassBar.tsx:65-67 | 首屏后部分下载失败时的兜底没有用例守着（G6 去掉 catch，用例全过） | 加一条单元用例：让 `./GlassBarFx.tsx` 的加载失败，断言页签、“＋”、设置入口照常能用，也没有未处理的 rejection |
| L15 | 低 | src/kit/components/GlassBar/GlassBarFx.tsx:57 | 代点没有检查 inert；inert 里的 `<a>.click()` 照样会跳转 | 在判断里加上 `n.closest('[inert]')`，或检查 `n.ownerDocument.querySelector('#root')?.inert` |
| L16 | 低 | src/kit/components/GlassBar/__tests__/GlassBar.test.tsx:97 | 没有用例覆盖“键盘弹着时不代点”（G2 没拦住） | 补一条：设 data-kb 让底栏 visibility hidden，在 html 上点底栏坐标，断言没有跳转 |

### 12.6 评分与结论

**8.5，通过。必改：无。** 首屏 149.7 KB 没超上限，但只剩 0.3 KB；分包失败时外壳照常能用；代点在常见情形下不会误触。建议 L13～L16，其中 L15、L16 各改一两行，建议这次一起改。

## 十三、复审：R6 过渡中代点页面内容（做法 A）、L13～L16（2026-11-05 15:21:40 快照）

在独立副本 cr-r18 里核对。e2e 端口：wrangler 8858、inspector 9298、假后端 9196 和 9197。跑完已删副本，确认这些端口都没人在听。

### 13.1 R6（GlassBarFx.tsx:22-58、:94-107）

- 做法：点按目标是 `<html>`、而且没落在底栏上时，进 tapThrough。
  - 不在过渡里（没有 ::view-transition 动画）、或者过渡开始还不到 50 ms：不代点；
  - 否则先把过渡动画放完，再用 elementFromPoint 找目标（伪元素层还没撤时，每 16 ms 重试一次，最多 10 次），只认链接、按钮、label、表单控件；
  - 禁用的、inert 里的、aria-hidden 里的不点；文字输入类只给焦点，不 click。
  - 没有 getAnimations 的环境按“不在过渡里”处理，不代点，偏保守。
- 首屏：代点逻辑都在 GlassBarFx 里，页面时钟实测仍是 149.7 KB，和上一轮一样，首屏 0 字节。
- elementFromPoint 本来就不命中 inert 节点；blocked 再查一次祖先，还能把底栏内容副本层（aria-hidden 加 inert）挡在外面。
- 变异 6 个（H1～H6），全部被拦住：
  - H1：底栏代点不查 blocked（L15）；
  - H2：去掉 50 ms 内丢弃；
  - H3：不放完过渡；
  - H4：页面代点不查 blocked；
  - H5：文字输入也 click，不给焦点；
  - H6：blocked 不看 inert、aria-hidden（红 2 条）。
- 剩下的风险（主持人定的口径，不扣分）：过渡开始 50 ms 以后的点按会点到**新页面**同一位置上的东西，用户看到的可能还是旧画面。新页面那个位置如果正好是待办的完成勾选（label、checkbox），就会顺手勾掉一条。这类操作有撤销条兜底；“彻底删除”之类的操作另有确认框，影响有限。建议在 e2e 里补一条：从今天页切到待办页、在勾选框的位置点，断言出现撤销条（L17）。

### 13.2 L13～L16

| 项 | 结果 |
|---|---|
| L13 | 按 CI 的 worker 数复跑：`--workers=2 --repeat-each=2` 跑 vt-taps、底栏、过渡、首屏预算 4 组，**56 条全过**；首屏预算 4 次都是 149.7 KB，今天页 0.8～2.0 秒出来。D1 那条的采样改成“至少 900 ms 而且至少 21 次，最多 5 秒”，不再按固定次数。上一轮 4 个 worker 红，是本机被多个会话占满造成的，这个解释我接受。首屏预算那份文件归前端 A，这次没改，保持现状 |
| L14 | 变异 H7：去掉外壳的 catch 以后，GlassBar-offline.test.tsx 报未处理的 rejection，vitest 判这次运行失败。已关 |
| L15 | H1 拦住了。已关 |
| L16 | 变异 H8：键盘弹着也代点，红；“inert 里不代点”也有用例（H6 拦住了）。已关 |

- 底栏的单元用例 25 条全过。

### 13.3 问题表

| 编号 | 严重程度 | 文件 | 问题 | 建议 |
|---|---|---|---|---|
| L17 | 低 | tests/e2e/b2-vt-taps.spec.ts | 过渡开始 50 ms 以后代点到新页面的勾选框、按钮，这种情形没有 e2e 覆盖 | 补一条：从今天页切到待办页时在勾选框的位置点，断言出现撤销条、可以撤销 |

### 13.4 评分与结论

**9.0，通过。必改：无。** R6 在首屏 0 字节的前提下做到了，6 个变异全部被拦住；L13～L16 都已关。建议 L17。
