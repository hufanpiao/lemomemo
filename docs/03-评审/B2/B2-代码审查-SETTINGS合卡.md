# B2 代码审查：SETTINGS 合卡（R-325，SETTINGS-merge-cards）

- 审查员：独立代码审查员（只读，默认不通过，满分 10，8 分算过）
- 日期：2026-11-06
- 对象：工作区未提交改动（相对 HEAD 3ff0410），设置首页三张卡、二级页路由、SettingsSub、SettingsHome、kit 的 Settings 组件、MeAvatar / useMeInitial 抽出、today 转出、相关单测和 e2e（b1-settings*.spec.ts）。
- 方案：docs/09-路线图/B2-SETTINGS-merge-cards-方案.md 第 10 节。
- 快照说明：审查期间工作区还在被改（09:10～09:13 有人落设计评审 L-1～L-4：数据页导出行两行排、返回按钮 font: inherit、句号）。代码通读以 09:03 快照为准，e2e 和样式核对用的是 09:15 的最新快照，L-4 的导出行样式已在浏览器里核过（见第 3 节）。

## 结论：8.5 分，通过；没有必改项

负责人定的四点都做到了，二级页路由、分包失败兜底、焦点和滚动还原都对，首屏体积几乎没变，测试大部分能拦住回归。下面几条是建议，不挡合入。

## 1. 负责人定的四点

| 要求 | 结论 | 依据 |
|---|---|---|
| 账号行用今天页同一个首字母头像圈 | 做到 | 两处都用 `kit/components/MeAvatar.tsx`；e2e `b1-settings-account-row` 比对了两边的宽高、::before inset、圆角、底色、字号，结果完全一样（44×44） |
| 首页导出中只写“正在导出…”，不写 MB | 做到 | 新短键 `settings.data.busyShort`；`export-split.test` 在取回第一片以后仍断言只写“正在导出…”；变异 G（换成长句）被抓到 |
| 设备、注销挪进账号二级页，“导出全部”挪进数据二级页 | 做到 | `SettingsPage.test` 断言首页没有设备行、注销入口和导出按钮，二级页里有；e2e 同样断言 |
| 分包失败当次不重试（A27） | 做到 | `SubLoadBoundary` 一旦失败就一直显示“这一页没加载出来”；React.lazy 会把失败的 promise 缓存住，退回首页再进来仍是失败页，和 A27 一致；顶栏返回照常能点 |

## 2. 重点项逐条

### 2.1 二级页路由、分包兜底、焦点和滚动还原
- 路由：`viewOf`、`parentOf`、`ENTRY_OF` 都对。注销页的上一层改成账号页，“点进来的退一步、直接打开的原地换成上一层”沿用 router 的 `backOrReplace`，router 本身没改。settings-sub-history 补齐了 account、data、about 三页的退一步、replace 和焦点回入口，还加了注销页回到账号页的用例。
- 滚动还原（S1）：只在首页点进二级页时记 `homeScrollY`，回首页时 `scrollTo` 还原，放回焦点用 `preventScroll`，有单测，变异 E、H 都被抓到。
- 焦点：`focusIsFree` 防抢焦点，变异 K 被抓到。
- **发现（低，建议 S1）**：`sub()` 返回的 `<SubView>` 没有 key。两个二级页之间直接换地址、中间不经过首页时，SubView 不会重新挂载，于是（a）上一页的分包失败状态会带到下一页，（b）标题焦点的 effect 不会再跑。我在副本里写了探针确认：日历分包失败以后把地址直接改成 `#/settings/about`，页面仍显示“这一页没加载出来”，关于页的正文没出来。现在应用里没有直接跳二级页的地方（grep 过），只有手动改地址才会碰到，所以记为低；以后要是加了从提醒横幅跳 `#/settings/remind` 这类深链接就会出问题。改法：`<SubView key={view} …>`。

### 2.2 MeAvatar 抽出后今天页行为
- 外观：原来 `.me` 和 `.me::before` 的样式原样搬进 `MeAvatar.module.css`，`.me` 只留下 44 的点击区、圆角、焦点框和电脑版隐藏。e2e 实测两边的计算样式一样。
- 读屏：今天页的 `<a>` 仍然靠 `aria-label` 取名；首字母原来是直接写在链接里的文字，现在放进了 `aria-hidden` 的 span，名字不变，也不会再念出多余的首字母，这一点比原来更好。
- `useMeInitial` 搬到 `kit/hooks`，`features/today/hooks/useMeInitial.ts` 改成转出；现在只有 `today/__tests__/me-initial.test.ts` 还在用这个转出（见建议 S6）。
- 变异 J（今天页不用 MeAvatar）单测抓不到，要靠 e2e 的 `[data-testid="today-settings"] > span` 比对，方案里写过，可以接受。

### 2.3 账号行两行排（stacked）
- kit 加了可选的 `stacked`：行名和值包进 `.stack` 竖排，值加 `.vBelow`（`white-space: normal`、`overflow: visible`、左对齐、`overflow-wrap: anywhere`）。不带 stacked 的行还是原来的结构，kit 单测两种都覆盖了。
- 设置首页只有账号一行带 stacked（`id === 'account'`）。**变异 B（改成 `stacked={false}`）单测抓不到**，只有 e2e 能拦住（`expectAccountRowWhole` 的 below 和 vCut 两项）。建议在 SettingsHome 这一层补一条单测，断言账号摘要的父元素是 `.stack`（建议 S3）。
- 注释没跟上：zh.ts 里 `settings.account.devicesList` 的注释、SettingsHome `accountValue` 的注释还写着“太长时单行省略”，Settings.tsx 头注释写的是“值单行省略”，都没提 stacked 这个例外（建议 S4）。

### 2.4 长邮箱 `<wbr>` 断行
- 没有 XSS：`mailLabel` 按 `/(?=@)|(?<=\.)/u` 切开，每一段都作为 React 文本子节点渲染，没用 `dangerouslySetInnerHTML`，也没拼 HTML。我试过 `<img src=x onerror=1>@x.y` 这样的输入，切出来照样只是文本。
- 拼接：key 用 `序号:段`，不会重复；`a..b@c`、`.a`、`a.` 这些边界都切得对，`textContent` 和原邮箱一字不差（有单测）。邮箱本身经过 `readSessionEmail` 校验过格式，最长 254 字符，不会是空串。
- 读屏：`<wbr>` 不影响可访问名称。
- 一致性：账号二级页最上面那行邮箱还是只靠 `overflow-wrap: anywhere`，没插 `<wbr>`，长邮箱在两页断行的地方会不一样（建议 S5）。

### 2.5 测试能不能拦住回归
副本里做了 12 个变异（主仓库没动，跑完已还原），单测抓到 9 个：

| 变异 | 结果 |
|---|---|
| A 不管在哪一页都记首页滚动（去掉 `view === 'home'` 判断） | **存活**（单测、e2e 都没有覆盖） |
| B 账号行不 stacked | 单测存活，e2e 能抓到 |
| C 邮箱不插 `<wbr>` | 抓到 |
| D 去掉分包兜底 | 抓到 |
| E 回首页放焦点时不带 preventScroll | 抓到 |
| F 数据页回来焦点放错行 | 抓到 |
| G 首页导出中写长句 | 抓到 |
| H 不还原滚动 | 抓到 |
| I 注销页退回首页 | 抓到（5 条失败） |
| J 今天页不用 MeAvatar | 单测存活，e2e 能抓到 |
| K 不判焦点是否空闲 | 抓到 |
| L 头像不藏读屏 | 抓到 |

变异 A 的影响：从账号页点进注销页时会用账号页的滚动位置覆盖 `homeScrollY`，之后退回首页就滚到错的位置。建议补一条用例：首页滚到 420 → 进账号页 → 滚到 100 → 进注销页 → 一路退回首页，断言滚回 420（建议 S2）。

**删掉的“行高 44”断言是否合理**：合理。
- 语言一行现在多了第二行灰字说明（M1），不再是单行，原来“行高 44、切换框上下各 3”已经不成立，留下了切换框看得见 38、选项 32、点击区扩到 44 的检查；
- 数据页的导出行按 L-4 也改成了两行，原来量它 44 也不成立了；
- 注销行（账号二级页里）高 44、退出登录高 44、“重试”看得见 38 且点击区扩到 44，这些都还在；新加的数据、关于两行入口量的是按钮 44；账号一行改成“不低于 44、不截断、摘要在邮箱下面”。

留下的小缺口：数据、关于量的是按钮不是 `<li>`，行本身被撑高了查不出来；日历、提醒两行在懒加载的值到了以后没有量行高（建议 S7）。

### 2.6 首屏预算
在副本里分别构建了 HEAD 和改动版（`--mode e2e`），用 `build/check_size.mjs` 量：

| | 首屏 JS（gzip） | 全部 JS（gzip） |
|---|---|---|
| HEAD 3ff0410 | 128 372 B | 445 710 B |
| 合卡改动 | 128 393 B（+21 B） | 447 129 B（+1.4 KB） |

首屏要下载的文件还是那 7 个，MeAvatar 只多了几十字节，离 150 KB 的上限还很远。设置页本身仍是懒加载，二级页正文和日历、提醒的值也都还是 lazy。

## 3. 我跑过的检查
- `npx vitest run src/features/settings src/kit/components src/features/today src/features/calendar src/features/reminders --maxWorkers=4`：95 个文件 899 条全过。
- `npm run typecheck` 通过；改动文件和两份 e2e 的 eslint 没报错。
- e2e（副本，8851 / inspector 9291 / 假后端 9194、9195，跑完服务都关了）：b1-settings、b1-settings-account-row 加一条探针，chromium + webkit 19 条过、1 条跳过。探针量了数据页“导出全部数据”一行（L-4 最新稿）：竖排、左对齐、上下内边距 8、间距 2，两段左边对齐。

## 4. 建议项（不挡合入）
- S1（低）：`sub()` 里给 `<SubView>` 加 `key={view}`，免得二级页之间直接换地址时带上一页的失败状态、标题拿不到焦点；配一条“失败后直接换地址”的单测。
- S2（低）：给 `openSub` 里 `view === 'home'` 才记滚动这个判断补一条用例（变异 A 存活）。
- S3（低）：在 SettingsHome 这一层补一条单测，断言账号一行是 stacked（变异 B 只有 e2e 能抓）。
- S4（很低）：清理过时的注释和名字：calendar/reminders 的 index.ts 还写着 `props: { onOpen }`；`CalendarSettings.tsx` 第 2 行还提 `CalendarSettingsEntry`；文件名 `*SettingsEntry.tsx` 导出的是 `*SettingsValue`；“单行省略”的几处注释见 2.3。
- S5（很低）：账号二级页那行邮箱也用 `mailLabel`，两页断行一致。
- S6（很低）：`me-initial.test.ts` 挪到 kit，或者改成从 kit 引用，然后删掉 today 那个转出文件。
- S7（很低）：单行行高按 `<li>` 量，日历、提醒两行等值到了以后再量。
