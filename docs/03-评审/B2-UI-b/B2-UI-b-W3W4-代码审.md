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
