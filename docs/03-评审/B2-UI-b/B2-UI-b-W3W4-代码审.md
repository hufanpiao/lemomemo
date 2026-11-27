# B2-UI-b 前端 B：W3/W4、开关合并、设置页像素锁定、W8、W9 代码审

- 审查人：独立代码审查子 agent，2026-11-09。只读，没有改代码。
- 依据：docs/09-路线图/B2-UI-b-任务单.md（W3、W4、W8、W9，D1 ①“外观一模一样，只换实现”，R1）、R-276、R-277。
- 范围：kit（Settings.tsx、SettingsRows.tsx、Settings.module.css、Form.tsx、Form.module.css 及三份单测），设置页 8 个文件和 SettingsPage.module.css，account-email-gap、settings-jump-css 两个测试，b2-ui-b-lock.spec.ts、linux 基准、playwright.visual.config.ts、ci.yml，W9 记录。
- 本人跑过：`npx vitest run` Form、FormButton、Settings 三份单测加 src/features/settings，415 条全过。没有起服务，没有跑 e2e。

## 结论

**有条件通过，8 / 10。** 实现干净，换零件没有丢行为；一条必改（锁定用例补数值断言），改完不用再审全文，只看那一处。

## 重点逐条

| 重点 | 结论 | 依据 |
|---|---|---|
| 看得见的变化只有三处 | 认可 | 八关自验 ⑦-4：12 个状态的计算样式逐项比，只多出 cursor pointer，加上任务单写明的“注销账号”危险色、导出行带 ›；主持人 11-09 看过对照图。<br>我怀疑过的一点已排除：FormButton 基础样式写了 `font: inherit`，旧 .btn 没写，但 src/styles/base.css:203 全局 `button { font: inherit; }`，字体不变。<br>`.compact` 的高 38、灰底、无边框、padding 0 14、pill 圆角、fs-14、字重 400 和旧 .btn 一致；`.full > button:disabled`（0,2,1）盖得住 `.compact.dangerFill:disabled`，“没输对时灰底灰字”保住了 |
| danger 自动带 data-no-proxy | 语义对，但建议解耦 | 目前只有“注销账号”入口用 SettingsEntryRow 的 danger，HEAD 这一行本来就带 data-no-proxy，行为不变；危险入口在底栏过渡期间不被代点，符合 GlassBarFx NOT_NAV 的用意。<br>问题是“红字”和“不代点”绑在一个参数上，以后谁想要红字但可以代点的行（或反过来）会被带偏。见建议 1 |
| 录键框换 FormButton 后的聚焦 | 对 | FormButton 不转发 ref，外面包一层 span，effect 里 `recRef.current?.querySelector('button')?.focus()`；Pressable 只接管 pointer 事件和 type，onKeyDown、onBlur 原样落到 button，录键和失焦取消都在。导出“继续/取消”的聚焦也是同一个办法，注释已更新 |
| 锁定用例锁没锁到 R-276、R-277 的数值 | **只锁住了一半** | 截图按元素外框外扩 3px、0 像素差，所以“退出登录”44 高、“重试”38 高、“注销账号”行 44 高一旦变了，图片尺寸就变，会红——这是间接锁住。<br>但：① `::after` 把点击区扩到 44 是看不见的，截图锁不住（只靠 hit-target e2e 的“≥ 44”兜底）；② 基准是改后生成的，谁跑一次 `--update-snapshots` 就把数值一起改掉，没有任何一句断言写着 38、44。见必改 M1 |
| ci.yml 改动最小、权限 | 对 | 只在“底栏视觉锁定”后加一步 `npm run e2e:visual -- --project=chromium-b2uib-lock`，没有改 permissions、secrets、镜像、触发条件。<br>注意：工作区里 deploy-preview.yml、release-build.yml 也有改动，不在本单范围，提交时别混进来 |
| linux 基准用 Node 26、--engine-strict=false 装的依赖 | 对截图基本没影响 | 截图由 Chromium 和字体决定：Chromium 版本跟锁文件里的 Playwright（1.64.1）走，镜像按 digest 钉死，字体也在镜像里；Node 版本不参与渲染。package.json、package-lock.json 没有改动，装出来的依赖树一样。<br>剩下的风险：CI 是 NODE_VERSION 24 + `npm ci`，和生成时的跑法不同。第一次 CI 跑这一步就是复核；若红，在 CI 里重生成，不要在本机改基准 |

## 其他核过的地方

- 设置页旧样式（.grp/.row/.rowBtn/.btn/.primary/.wide/.signOut/.toggle 等）删干净，settings-jump-css 改为检查 kit 里的按下变淡和减少动态效果规则，并断言设置页 CSS 里不再出现 .rowBtn，测试跟着迁移、没有放水。
- 开关只剩 Form.module.css 的 .switch 一份；`.check input:not([role="switch"])` 避免开关被复选框样式盖掉。合并前后用同一用例对跑 0 像素差，有记录。
- DevicesSection：“移除”是 compact danger，读屏名照旧走词典；元信息拼成一个 meta，文字和 HEAD 相同。
- RecentExport：行改成 SettingsDetailRow，“未完成”“邮件没发出去”两个 testId 保留；`.danger` 改成设置页自己的 `.dangerText`，不和 kit 的 .danger 撞名。
- DeleteAccountView 提交按钮自己带 data-no-proxy，没靠 danger 自动加，和 HEAD 一致。
- W8：随手记 62pt 截图加“标题上沿 ≥ SAFE_TOP + --top-fade”断言，这一条是真断言，好。
- W9 记录：352 条里 12 条失败逐条有原因（9 条缺假后端，3 条 b1-settings 冷启动，单独重跑 3 遍全过），审查员点名的几条有结果。可以关。

## 必改

- **M1 锁定用例补数值断言。** 在 b2-ui-b-lock.spec.ts 里，对已截图的元素加 boundingBox 断言：compact 按钮（“重试”）高 38；“退出登录”高 44（R-277）；“注销账号”入口行高 44；compact 按钮 `::after` 的计算宽高 ≥ 44（用 `getComputedStyle(el, '::after')` 取，R-276 点击区）。这样基准被重生成也丢不了 R-276、R-277。

## 建议（不拦）

1. SettingsEntryRow 的 danger 和 data-no-proxy 分开：另加 `noProxy` 参数，或至少在 danger 的注释里写明“danger 同时表示不代点”。
2. 锁定覆盖补几块：确认弹窗的 primary / dangerFill 那一对、设备行“移除”、导出行（带 ›）、电脑版录键框和“恢复默认”。这些都换了实现，现在只靠计算样式对比的一次性记录。
3. W9 记录里 6 条 files.spec、3 条 b1-version-gate 要假后端的，写明在哪次 CI 或哪个环境补跑过，补上结果。
4. 文件登记册里 linux 基准写的是“官方镜像里 npm ci 按 package-lock 装”，和主持人转述的“Node 26、--engine-strict=false”对不上，统一成实际跑法。第一次 CI 跑 chromium-b2uib-lock 后，在八关自验 ⑦ 里补一句 CI 结果（Node 24 + npm ci 下 0 像素差），把 Node 26 生成的疑问关掉。

## 复审：首屏预加载去重补的三条建议（2026-11-10）

- 审查人：独立代码审查子 agent。只读，没有改代码；本节是唯一写入。
- 范围：vite.config.ts（注释、buildStart 清 graph）、build/check_size.mjs、build/check_preload.mjs（新）、tests/build/check-preload.test.ts（新，8 条）、tests/build/preload-dedupe.test.ts、文件登记册两行；另看 W9 记录第 48 行、八关自验第 67 行的措辞。
- 本人跑过：
  - 两份测试，13 条全过；
  - 用当前工作区在 scratchpad 临时目录里另构建一份（`vite build --mode e2e --outDir …`，保留 .vite/manifest.json，用完已删），跑 check_size：58 处懒加载核对，0 报错；首屏净增 983 B / 额度 1024 B（基线 111826 B，即首屏 112809 B）；
  - 拿同一份 manifest，把“不去重时的表”当成实际的表喂给 checkCall：55 处里 53 处报错，没报错的 2 处是宿主闭包和目标闭包本来就不重叠。

**分数：8.5 / 10，及格。**

### 抽查前端 B 的说法

- “不去重时 57 处里 55 处报错”：说法成立。我模拟出来是 55 处里 53 处，比例一致；条数差几处，是因为工作区代码在两次构建之间又变了（我这份是 58 处）。
- “首屏 112729 B”：我这份是 112809 B，多 80 B，也是工作区里别人的改动带进来的；仍在额度内。提交时以 CI 那次构建的数为准。

### 必改

- **M1 两处 CI 结论要标成“推断”，不能写成已核实。**
  - docs/03-评审/B2-UI-b/W3W4-八关自验.md:67 开头直接写“0 像素差，通过”，“按步骤结果和配置推出来”的说明放在段尾，读的人只看开头会当成看过日志。改成开头就写“按 CI 步骤结果推断：0 像素差”，后面再列依据（retries 0、maxDiffPixels 0、用例里没有 skip）。
  - docs/03-评审/B2-UI-b/W9-csp夹具收尾-e2e跑通记录.md:48 “所以这 9 条在 CI 里都跑了、最终都通过”同样是推断：改成“按步骤结果和配置推断”。后面“还没核实到的一点”（有没有靠重试才过）保留。

### check_preload.mjs 会不会在 CI 产物里误报

照 CI 的跑法（build_web.mjs:65 在构建里、.vite 还在时调 check_size），用的是这次构建自己的 manifest，当前产物 0 误报。以后可能误报的地方有三处，都不拦：

1. **只按 manifest 推断“该有表”**（build/check_preload.mjs:103-106）：
   - 动态 import 的目标本身就在宿主静态闭包里时，去重会把整张表去空，Vite 就不写表了，这里会报“整张预加载表不见了”；
   - 动态 import 的目标不走 Vite 预加载时（例如带 `/* @vite-ignore */`），也会报同一个错。
   - 现在产物里这两种都是 0 处。建议算出来“该留的 JS 为空、CSS 也为空”时不要求有表。
2. **用表的第一项当目标**（:64-66）：同样是目标在宿主闭包里的情况，第一项会变成别的块或 CSS，报“表的第一项不是 JS”。建议从代码里 `import("./x.js")` 的地址取目标，或者对照 manifest 的 dynamicImports。
3. **manifest 的后备路径**（:12）：找不到 `<appDir>/.vite` 时，会去读 dist/vite-manifest。那份只有默认输出目录 dist/web 才会更新（build_web.mjs:70）。所以构建完以后对 dist/web-xxx 单独跑 `npm run size -- --app-dir …`，会拿到别的构建的 manifest，大面积报错。我在旧的 dist/web-b8833、dist/web-visual 上跑，就出了 103、105 条假错。check_size 原来的体积检查也是这个找法，但它不会这样硬报错。建议后备 manifest 只在 appDir 是 dist/web/app 时才用，或者先核对 manifest 里的文件在 assets 里都存在，不存在就报“manifest 和产物对不上”。

### 上一轮三条建议

- 建议 1（真实产物核对）：已解决。check_preload.mjs 核三件事（宿主已加载的 JS 不列；其余 JS 一个不少、也不多；CSS 和不去重时一样），按 Vite 8.3.5 collectPreloadDependencies 的顺序重算（:37-50，和 node.js:27240 一带一致）。check_size.mjs:150-155 每次构建都调。测试 8 条覆盖了通过、①、② 少 JS、② 多 JS、② 整张表不见、③ CSS 少一个、③ 顺序变、没有 assets 目录时跳过。
- 建议 2（钩子顺序注释、buildStart 清 graph）：已解决，vite.config.ts 里 preloadGraph 的注释和 buildStart 都在。
- 建议 3（chunk import map 失效方向）：已解决，写在 dropHostLoaded 上方的注释里。
- 文件登记册：两行在（:920、:3227）。
