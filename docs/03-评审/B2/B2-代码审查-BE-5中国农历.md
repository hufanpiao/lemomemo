# B2 代码审查：BE-5 中国农历（运行时换算 + 首尾零头月）

- 日期：2026-11-03
- 审查人：代码审查员（只读，默认不签）
- 对象：工作区未提交改动——`tools/lunar/adapters/hko-txt.mjs`、`tools/lunar/lib.mjs`、`tools/lunar/build.mjs`、`tools/lunar/sources/cn-months.json`、`shared/logic/anniv/lunar-data.ts`（生成）、`tests/build/lunar-hko.test.ts`、`tests/build/lunar-tools.test.ts`；新文件 `shared/logic/anniv/lunar.ts`、`shared/logic/anniv/lunar-names-data.ts`、`tests/shared/anniv/lunar.test.ts`、`tests/build/lunar-runtime-hko.test.ts`
- 对照：架构 5.4“数据”、5.12 第 1 点、第 9 节（单元 lunar、三时区）、2.6；B2 任务单 BE-5（第 150 行）

## 结论：有条件签，8.5 / 10

换算本身是对的：运行时 `toLunar`、`solarTermOf` 和香港天文台原始表 1901-01-01～2100-12-31 共 73049 天逐日对拍全部一致，生成链路能拦手改，时区安全，没有进首屏。签字条件是下面的 M1 改完，外加 C1 由负责人定。

**和任务单、架构不一致的地方（放最前面）**
- **C1 覆盖范围少了 1900 年**：BE-5 和架构 5.4 写的是“中国 1900～2100”，实际只做到公历 1901-01-20 起，也就是农历 1900 年只有腊月。原因是香港天文台的表从 1901 年起，开发者已经标了待负责人定。负责人定了以后（补紫金山的数据，或者把 1900 年改成不覆盖），要同步改架构 5.4 的“1900–2100”两处和 BE-5 那一行。
- **C2 韩国部分整块还没有**（不在这次“中国部分”的范围里，只是提醒）：BE-5 要求 B2 做韩国 1900～2050 和两国逐月比对。现在 `'kr'` 一律返回 null，韩文界面月历在 B2 完全不显示农历和节气。BE-5 要等 KASI 数据进来才能整体验收。

## 必改

| 编号 | 位置 | 问题 | 改法 |
|---|---|---|---|
| M1 | `shared/logic/anniv/lunar.ts` 第 146～157 行 `leapMonthOf` | 只在“正月 ～ 腊月之前”这段里找闰月（`for (i = from; i < to)`），**闰腊月排在腊月后面，永远找不到**，会返回 0。编码本身支持闰 12（bit 13～16），`toLunar`、`toSolar` 也认得。现在中国 1901～2099 恰好没有闰腊月和闰正月（实测分布：闰 2～11 共 73 年，其余 126 年无闰），所以测试是绿的；但这是公开接口的契约错误，韩国数据或别的来源一进来就会错，新建纪念日的“闰月”开关也靠它。 | 改成按 `rows` 里 `y === year` 的所有行找 `leap`（腊月还没结束的 open 年照旧按看得到的部分算）；再补一条测试：1901～2099 每年 `leapMonthOf` 和 `LUNAR_CN.years` 的 bit 13～16 逐年一致，外加一张带闰 12 的合成表（或者直接对 `decodeTable` 的结果）断言返回 12。 |

## 建议（不阻塞签字）

1. **防止以后被打进首屏**：现在 `src/` 里没有任何地方 import `anniv/lunar*`（已经核对过），但前端 A 接 `calDayInfo` 的时候很容易写成静态 import。建议在 check_arch（或 eslint `no-restricted-imports`）加一条规则：`src/` 只能用 `import()` 动态加载 `shared/logic/anniv/lunar.ts`、`lunar-data.ts`、`lunar-names-data.ts`；或者让 check_size 断言首屏 chunk 里没有 `LUNAR_CN`。
2. **variant 传错直接抛 TypeError**：`toLunar('…', 'xx')` 会报 `Cannot read properties of undefined (reading 'head')`。数据库有 `check (lunar_variant in ('cn','kr'))` 约束，风险低，但这几个公开函数可以在 `TABLES[variant]` 取不到时返回 null，和“没有数据返回 null”的口径一致。
3. **给 B5 留话：区分“这一天不存在”和“超出覆盖范围”**：`toSolar`、`lunarMonthDays` 对这两种情况都返回 null。架构 5.4 的兜底（三十日不存在就用廿九）在 2100 年腊月会把“数据结尾”误当成“小月”，好在退到廿九也还是 null，结果不会错。建议在 `lunar.ts` 文件头写一句：nextDate 用 `lunarRange` 或 `leapMonthOf` 判断是不是超出范围，不要只看 null。
4. **`lunarDayInfo` 和 `MonthOpts.dayInfo` 签名差一个参数**：`dayInfo` 是 `(date) => …`，`lunarDayInfo` 是 `(date, locale)`，前端要包一层 `(d) => lunar.lunarDayInfo(d, locale)`。可以接受；建议在 `useCalendar.ts` 的 `calDayInfo` 注释里写出这一行，免得各写各的。
5. **`toLunar` 的 `n >= end` 判断目前是多余的**（去掉它测试照样全绿，因为 open 月 `days = 1` 已经挡住了）。保留没问题，它才是真正兜底的那道判断；建议补一条测试：拿一张 `days` 大于 `end - start` 的合成表，确认 end 以后查不到，免得以后有人当成多余删掉。
6. **1941～1945 年夏令时**：适配器注释说表尾的“夏令时间”说明“只影响时刻，不影响日期”。这几年的节气或朔日如果离午夜很近，按香港夏令时和按北京时间划日可能差一天。用户几乎碰不到，建议在 SOURCE.md 记一笔“未逐条核实”，或者 B5 做天文推算时顺便核一下。
7. 节气划日的口径已经写明：`solarTermOf` 注释写了“中国东八区、韩国东九区”，适配器注释写了“香港时间 UTC+8，与北京时间同”，`build.mjs` 写了 KASI 适配器要“按东九区划日期”。建议在 `lunar-data.ts` 的生成头注释里也加半句“TERMS_CN 按东八区划日、TERMS_KR 按东九区划日”，读数据的人不用再翻适配器。

## 核对通过的项

- **换算正确性**
  - 逐日对拍：`toLunar`、`solarTermOf` 和原始表 1901～2100 年全部 73049 天一致；开头 19 天（1901-01-01～19，冬月还是闰冬月推不出来）返回 null；节气正好 4800 个。
  - 闰月：2023 闰二月、2025 闰六月、2033 闰十一月跨公历年都对；闰月当年没有时 `toSolar` 返回 null，同号平月的兜底按架构 5.4 归 `nextDate`（B5）。
  - 大小月、春节前后：2026 腊月小（只到廿九）、2099 腊月大、2025 除夕都对；`toSolar(…, 30)` 遇到小月返回 null。
  - 首尾边界：1901-01-19 及以前、2101 及以后返回 null；2100-12-31 是腊月初一；`toSolar(2100,12,2)` 返回 null；`lunarMonthDays(2100,12)` 返回 null（大小月不知道）；`leapMonthOf(1900)` 返回 null（这一年不完整）。
  - 随机抽 3000 天（固定种子）做 `toSolar(toLunar(d)) = d`，同时核对月天数，都通过。
- **时区安全**：改动的 5 个文件里没有本地时区的 `Date` 用法（没有 `getFullYear`、`getDate`、`new Date()`、`Date.now`、多参数 `new Date`），全部走 `Date.UTC` 和 `getUTC*`。三个时区（UTC、首尔、洛杉矶）实跑都通过，Deno 下 `lunar.test.ts` 18 条通过，`deno check` 通过。
- **生成链路**：手改 `lunar-data.ts` 里一个数，`check:lunar` 拦住，4 条测试失败；只改适配器（把 open 月记成 30 天），`check:lunar` 拦住（sources 和原始表不一致），3 条测试失败。原始表有 SHA256SUMS，SHA256SUMS 自己的哈希又写死在代码里；203 个原始文件已经入库；CI 的 `unit.yml` 跑 `npm run check:lunar`。
- **open 月不会被当成完整的月**：`validateMonths` 只允许最后一个月标 open，天数 1～30；`encodeMonths` 的 `isFull` 把带 open 的年排除在整年之外，放进 tail；`decodeYears` 和运行时都把 open 带回来；`compareCountries` 遇到 open 月只比初一；`lunarMonthDays` 对它返回 null。
- **接口**：`lunarDayInfo` 返回 `{ lunar?, solarTerm? }`，和 `MonthOpts.dayInfo` 的返回类型一致；中文界面用中国农历，韩文界面用韩国阴历，没有数据就什么都不给，符合 5.4、5.12。初一显示月名，符合“农历初一显示月份”。
- **体积和首屏**：`src/` 里没有静态 import（只有 `useCalendar.ts` 一处注释提到）。3 个文件源码 gzip 后合计约 8.3 KB（含注释），压缩后约 4 KB 的说法可信。名称放在 `*-data.ts`，按 check_arch 的 A20 豁免（`rel.endswith("-data.ts")`）过检，也符合 i18n 第 2 条“阴历月日、节气名存数据表、中韩两种文字”。
- **测试能拦住回归**（变异试验，改完都还原了，4 个文件 sha1 一致）：
  - 闰月位置错一位：5 条失败
  - 大小月位反过来：10 条失败
  - open 月返回天数：1 条失败
  - 手改 lunar-data：`check:lunar` 和 4 条测试一起拦住
  - 适配器 open 月记成 30 天：`check:lunar` 和 3 条测试一起拦住
  - 去掉 `n >= end`：没拦住，属于等价变异（见建议 5）

## 跑过的测试

| 命令 | 结果 |
|---|---|
| `npm run check:lunar` | 通过（lunar-data.ts 和 sources、sources 和原始表都一致；韩国跳过） |
| `npx vitest run tests/shared/anniv tests/build/lunar-hko.test.ts tests/build/lunar-tools.test.ts tests/build/lunar-runtime-hko.test.ts` | 4 个文件 46 条全部通过 |
| `node build/run_tz_tests.mjs --project node tests/shared/anniv tests/build/lunar-runtime-hko.test.ts tests/build/lunar-hko.test.ts` | UTC、Asia/Seoul、America/Los_Angeles 各 39 条通过 |
| `deno test --allow-read=. tests/shared/anniv/lunar.test.ts`、`deno check shared/logic/anniv/lunar.ts` | 18 条通过；类型检查通过 |
| `npm run typecheck` | 通过 |
| `npx eslint shared/logic/anniv tools/lunar tests/shared/anniv tests/build/lunar-*.test.ts` | 0 问题 |
| `python -I build/check_arch.py` | 0 个错误，2 个警告（W2：两国 2027 节假日文件缺，不属于这次改动） |
| 变异试验 6 种（见上）＋临时测试核对闰月分布和传错 variant | 源文件已还原（sha1 核对一致） |

**用过的临时文件**：`tests/shared/anniv/zz-review-tmp.test.ts`，两次用来打印闰月分布和传错 variant 的结果，每次跑完都立即删掉，审完已确认目录里只剩 `lunar.test.ts`。中途另一位后端跑 typecheck 时也删过一次（以为是残留）。这个审查不再需要它。另外在会话的临时目录建过一个 `leap.test.ts` 草稿，没有写进仓库。

没有跑 `tests/build/gen-tauri-key.test.ts`，没联网，没碰 Supabase 和 Docker。

---

## 复核（2026-11-04）：通过，9.2 / 10

对象：M1 修复、上次的 7 条建议、16 个 F7 修复（`shared/logic/anniv/lunar.ts`、`lunar-names-data.ts`、`lunar-data.ts`、`tools/lunar/*`、`tests/shared/anniv/lunar.test.ts`、`tests/build/lunar-runtime-hko.test.ts`、`src/features/calendar/hooks/useLunar.ts`），以及 check_arch 新增的 LUNAR 规则和 W2 pending 规则。只读复核，没改代码。

M1 已经改对，上次的 7 条建议全部落实。剩下的三件事都不影响通过，见本节末尾。

### 逐条核对

| 编号 | 结果 | 依据 |
|---|---|---|
| M1 `leapMonthOf` 找不到闰腊月 | 已解决 | 改成 `leapMonthIn`，按 `y === year` 的所有行找闰月。数据结尾没结束、又没找到闰月时返回 null，所以 2100 年从 0 改成了 null。补了合成闰腊月表，断言返回 12；另有 1901～2099 逐年和 bit 13～16 一致的测试 |
| C1 1900 年没覆盖 | 负责人已定 | R-319“从 1901 年起”（明早待确认第 83 条） |
| C2 韩国部分没做 | 负责人已定 | R-318“韩国阴历先不做，只做节假日”（明早待确认第 82 条） |
| 建议 1 防止进首屏 | 已解决 | check_arch 新规则 LUNAR，详见下一小节 |
| 建议 2 版本传错抛 TypeError | 已解决 | 改成 `lunarTableOf`/`termTableOf` 返回 undefined，函数一律返回 null；日期格式不对照样抛 bad_date；有测试 |
| 建议 3 给 B5 留话 | 已解决 | 写进 B1 接手清单 LUNAR-nextdate-null，归 B5 后端 |
| 建议 4 `dayInfo` 少一个参数 | 已解决 | `useLunar.ts` 包了一层，`useCalendar.ts` 注释写明；`lunar.ts` 只经 `import()` 加载，类型用 `import type` |
| 建议 5 `n >= end` 没有测试 | 已解决 | 合成表加了“end 截断”测试 |
| 建议 6 1941～1945 夏令时 | 已解决 | `tools/lunar/raw/hko/SOURCE.md` 记为“待核实” |
| 建议 7 节气划日口径 | 已解决 | `lunar-data.ts` 头注释写明 TERMS_CN 按东八区、TERMS_KR 按东九区划日 |
| 16 个 F7 | 已解决 | 改用 `itemAt`，负下标不会倒着取到末尾；check_backend 0 个错误 |

### check_arch 的两条新规则

- **LUNAR（防止 `src/` 静态引入农历）**：违规样例 `tests/arch-fixtures/check_arch/lunar-static-import/` 里 5 种写法都报出来了，分别是 `import from`、`export from`、只写路径的 import、无后缀路径、`require`。对照样例里 `import()`、`import type`、注释和别的带 lunar 名字的模块都放行。真仓库 0 个错误。
- **W2 pending（明年的节假日文件还是 pending 也报警告）**：和架构 5.12、`tools/holidays/README.md` 第 42 行的约定一致。样例 `w2-pending` 里只报 cn，kr 的 2027 没有 pending 所以不报。JSON 格式不对交给 holidays 的检查脚本管。测试在 `tests/arch/check-arch.test.ts`。

### 还剩的三件事（不影响通过）

1. **文档没同步 R-318、R-319**：架构 5.4 第 2985、2990、2991 行和 B2 任务单第 28、150 行，仍写“中国 1900～2100、韩国 1900～2050”。**由主持人改。**
2. **LUNAR 规则只查 `src/` 里的直接引用**：如果以后 `shared/` 里某个模块（比如 B5 的 `anniv/nextDate`）静态引入 `lunar.ts`，而 `src/` 又静态引入了这个模块，农历会被间接打进首屏，这条规则拦不住。现在 `shared/` 里没有这样的模块。可以让 check_size 断言首屏 chunk 里没有 `LUNAR_CN`。**由主持人记进接手清单。**
3. **总的 typecheck 有失败**：`src/features/calendar/__tests__/CalendarSettings.test.tsx` 缺 `onBack` 属性，共 5 处 TS2741。这是前端日历设置页正在做的新文件，不在 BE-5 范围；shared、node、app 其余部分都过了，但合并前要有人处理。

### 复核跑过的测试

| 检查 | 结果 |
|---|---|
| `npm run check:lunar` | 通过 |
| vitest：农历 4 个测试文件加 `tests/arch/check-arch.test.ts` | 5 个文件 70 条全部通过 |
| `node build/run_tz_tests.mjs --project node tests/shared/anniv tests/build/lunar-runtime-hko.test.ts` | UTC、首尔、洛杉矶各 28 条通过 |
| `deno test --allow-read=. tests/shared/anniv/lunar.test.ts` | 23 条通过 |
| `tsc -p tsconfig.shared.json`、`tsc -p tsconfig.node.json` | 通过 |
| `tsc -p tsconfig.app.json` | 只有上面 CalendarSettings 测试的 5 处错误 |
| eslint（农历相关文件、日历 hooks、check-arch 测试） | 0 个错误 |
| `python -I build/check_arch.py` | 0 个错误，2 个 W2 警告（两国 2027 节假日文件还没放） |
| `python -I build/check_backend.py` | 0 个错误 |

复核没有建临时文件；没有跑 `tests/build/gen-tauri-key.test.ts`，没联网，没碰 Supabase 和 Docker，没做 git 操作。
