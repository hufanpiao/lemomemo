# B2 安全审查 · 推送负载加 occurrenceKey（REMIND-close-occkey）

- 审查人：安全审查员（只读；除本文件外没有改仓库里的任何文件，没有做 git 操作，没有连库）
- 日期：2026-11-04
- 审查对象（工作区未提交的改动，以 `git diff` 为准）：
  - `supabase/functions/_shared/push/payload.ts`：文件头第 4、10～15 行的字段说明，`ItemRef.occurrenceKey`，`occKey` 函数，`buildPayload` 里给 `base` 加键的两行
  - 调用处：`supabase/functions/push-dispatch/round-dispatch.ts` 第 214 行（remind）、第 263 行（resolve）；`supabase/functions/push-dispatch/logic.ts` 的 `occurrenceKey` 接线；值的来源 `shared/logic/remind-route.ts` 的 `occurrenceKey`、`isAllDayRemind`
  - 测试：`tests/shared/push/push-payload-occkey.test.ts`；顺带看了 `tests/edge/push-dispatch-occkey.test.ts`
- 依据：`B2-安全审查-S-B2签字.md` 第六之三节（负载只放白名单字段；锁屏只显示服务器给的 title、body；FE-3 负载和通知 data 同一套校验）；`B2-安全审查-BE-2推送调度.md`；payload.ts 文件头原有的“永远没有地址、图片之类的字段，运行时多给的键一律丢掉”；`src/sw/push.ts` 的 `parsePushPayload`
- 跑过的检查：
  - `npx vitest run tests/shared/push tests/shared/occurrence-key.test.ts tests/functions --exclude tests/build/gen-tauri-key.test.ts`：54 个文件，975 过、1 跳过、1 todo
  - `npx vitest run tests/edge/push-dispatch-occkey.test.ts tests/edge/push-dispatch-round.test.ts`：2 个文件 25 条全过
  - `deno test --allow-read=. tests/shared/push/push-payload-occkey.test.ts tests/shared/push/push-payload.test.ts tests/shared/occurrence-key.test.ts`：24 条全过
  - 另在会话草稿目录写了一个探测脚本（不在仓库里），直接调 `buildPayload` 试了 12 种边界输入和最坏字节，结果见第二、三节

---

## 结论：通过，本次后端改动没有必改

前端 SW 还没有读这个键（`src/sw` 里搜不到 `occurrenceKey`）。等前端接入时，要满足第六节的两条前提，这两条不算本次的必改。

---

## 一、会不会泄露负载里原本没有的信息

**写法 ①（等于 tag）：没有任何新信息。** 值是 `<kind>:<id>:<due_at>`，三段和负载里已有的 `kind`、`id`、`due_at` 逐字相同，只是把它们拼在一起，不合就不带。

**写法 ②（全天日程）：多了两项，都不是用户的自由文字，可以接受。**
- 多出来的是日程的日期 `YYYY-MM-DD` 和 `remind_days`（0 或 1）。
- 日期来自 `events.date` 列，`DAY_RE` 只认 10 个 ASCII 数字和连字符组成的格式，标题、正文、地点、备注这类用户输入都进不来。`remind_days` 只认字面上的 `:0`、`:1`。
- 这两项和负载里已有的 `due_at` 基本可以互推：全天日程的 `due_at` 就是“日期（或前一天）+ 默认时刻”。真正新增的只有两点：这条是不是“前一天提醒”，以及日期和 `due_at` 合起来能推出用户所在时区的大致偏移。这些都是这个用户自己这条提醒的元数据，敏感程度和 `due_at` 同一级。
- 负载经 aes128gcm 端到端加密，只发给这个用户自己绑定的设备，推送服务商只看到密文。SW 显示前先核对 owner（FE-1），这个键也不显示在锁屏上。

**对照六之三的签字口径**：口径是“只放白名单字段；不带地址、图片；锁屏上的文字只有服务器生成的 title、body”。这个键是白名单里新加的一项，类型和运行时都限定成只有 ASCII 小写十六进制、数字、`-`、`:` 和三个固定单词（event、todo、anniv）加 `allday`，不显示，也不是地址，符合口径。

**附带核对的几处**：
- 调用处的值只来自 `c.logic.occurrenceKey(kind, x.row, due)`。`logic.ts` 里，`tag` 由 `reminderTag(kind, row.id, due)` 现算；`snoozed` 由 `snooze_at`、`remind_at` 两个数字比较得出；`row` 只读 `date`、`time`、`remind_days`。都不经过用户可写的自由文字。
- 两处调用都在原来的 `try` 里面，算 key 出异常也只会照原逻辑记原因码，不会把值写进日志。日志里没有这个键。
- 旧客户端的 `parsePushPayload` 只挑认识的键，多出来的键直接忽略，不会因此拒收或改成兜底通知。

## 二、白名单校验严不严

`occKey` 的写法是：先判 `typeof v === 'string'`；写法 ① 要求整串全等；写法 ② 要求 `kind === 'event'`，前缀全等于 `event:<本条 id>:allday:`，接着 10 个字符要整段匹配 `DAY_RE`，剩下的部分必须全等于 `:0` 或 `:1`。`id` 在这之前已经过小写 UUID 校验，`due_at` 已经过正的安全整数校验。

| 情况 | 结果 | 依据 |
|---|---|---|
| 换行、控制字符（含 tag 末尾带 `\n`、日期后带 `\n`） | 不带 | 两种写法都要求全等或尾段全等；`DAY_RE` 只用来判截出的 10 个字符 |
| 超长（合格串后面接 5000 个 a） | 不带 | 尾段不等于 `:0`/`:1` |
| 多出尾巴（`:1:x`、`:01`）、前面多空格 | 不带 | 同上 |
| unicode：阿拉伯-印度数字、全角数字、日期里夹零宽字符 | 不带 | `[0-9]` 不带 `u` 标志，只认 ASCII；长度错位后尾段也对不上 |
| 大写 UUID、另一条的 id | 不带 | 前缀用本条小写 id 全等比较 |
| 其他 kind 冒用全天写法（todo、anniv，remind 和 resolve 都试了） | 不带 | `kind !== 'event'` 直接返回 null |
| kind 对不上的 tag 写法（本条是 event，给 `todo:<id>:<due>`） | 不带 | 和本条拼出的 tag 全等比较 |
| 非字符串（数字、对象、数组、`new String(...)`） | 不带 | `typeof` 不是 `'string'` |
| `9999-99-99` 这类格式对、但不是真实日期 | **会带** | `DAY_RE` 只校验格式。值只能是 ASCII 数字，不泄露信息，也没有注入面，只是语义上不严（建议 S1） |

上表里第 1～3 行和“其他 kind 冒用”在仓库的测试里已经有了；unicode 数字、大写 id、前导空格、tag 末尾换行、`String` 对象这几种是我用探测脚本补试的，结果都是“不带”。

长度上界是确定的：写法 ② 正好 62 字节；写法 ① 最长是 `event:` 或 `anniv:` 加 36 字节的 UUID、1 个冒号和最多 16 位数字，共 59 字节。

## 三、不截断会不会超上限、挤掉别的字段

- `occurrenceKey` 放在 `base` 里，参与每一次 `make()` 的字节计算，所以超长截断的循环会把它算进去。截的仍然只是 body，然后才是 title，最后还放不下就抛 `payload_too_large`。不存在“它把别的字段挤掉却没算进字节”的路径。
- 最坏情况探测（标题、正文各 300 个落单代理项，每个转义成 6 字节；推迟、知道了两个按键各 40 个；`due_at` 取最大安全整数；带 62 字节的全天 key）：整份 2602 字节，≤ 3071；title 保住 300 个码点；body 被截到 2 个码点。不带 key 时是 2521 字节，body 同样截到 2 个码点。这个键带来的增量约 81 字节（键名加引号加值），在最坏输入下只多截掉一点 body，不会挤到 title，更不会让整条发不出去。
- resolve 最长 239 字节，一定落在 1024 那一档。
- 填充档位的旁路：remind 多出约 81 字节，可能让少数原来贴着 1024 或 2048 边界的负载跳到下一档；写法 ① 和 ② 之间的长度差最多 7 字节。推送服务商看得到的仍然只是“标题、正文大概多长”这一级的信息，加这个键之前就已经存在，没有实质性的新泄露。

## 四、必改

无。

## 五、建议

- **S1（低）**：`DAY_RE` 可以收紧成月 01～12、日 01～31，或者再用 `Date.UTC` 往返核对一次。值都来自数据库的 date 列，所以不改也安全，收紧只是让白名单的文字说明和实际行为完全对得上。
- **S2（低）**：把探测里试过的几种情况补进 `push-payload-occkey.test.ts` 的 `bad` 列表：阿拉伯-印度数字或全角数字的日期、大写 id、tag 前导空格、tag 末尾 `\n`、`new String(...)`，并给 resolve 也跑一遍 bad 列表（现在只跑了 remind）。
- **S3（文字）**：payload.ts 文件头第 16 行写着“通知的 tag……都由前端按这几个字段拼，负载里不放”。现在写法 ① 的值和 tag 逐字相同，建议补半句：“occurrenceKey 写法 ① 和 tag 同值，但 tag 仍由前端自己拼，不从 occurrenceKey 取”，免得以后有人图省事直接拿它当 tag。

## 六、前端接入时的前提（不是本次必改，交给前端 A 的 SW 改动）

1. **SW 自己再校验一遍，和服务器用同一条白名单**：`parsePushPayload` 只在值等于 `notificationTag(kind, id, due_at)`，或者 kind 是 event、写法是 `event:<同一 id>:allday:<日期>:<0|1>` 时才收下，否则当作没有这个键。如果把它放进 `notification.data`，`dataOf` 读回来时也要按同一条规则再校验（FE-3 的口径）。
2. **只拿来比较，不显示，不拼进地址**：不要放进 title、body、按键文字，也不要拼进 `reminderUrl` 或 `openWindow` 的参数。建议在 `tests/build/sw-no-user-data.test.ts` 加一条静态断言钉住。

## 旁注（不属于安全范围，转代码审查）

- resolve 那一处的 key 是用推送时刻 `pushedFor` 和**当前**这一行算的。如果推送之后用户改了全天日程的日期或 `remind_days`，resolve 带的 key 会和当初推出去的那一条对不上，本机就撤回不了旧通知。tag 是按 `pushedFor` 拼的，还能替换掉旧通知，所以不会漏关，但“按 key 撤回”这条路会失效。
- 截断循环按“每个字符 4 字节”估算要删多少字。遇到 6 字节的转义字符时会多删：最坏探测里还空着 469 字节，body 却被截到只剩 2 个码点。这是原来就有的行为，和这次改动无关。

---

## 复核（11-04，只看 S1～S3 和新加的撤回兜底约定）

结论：**通过，没有剩余必改。**

- **S1 已解决**：`isRealDay` 在 `DAY_RE` 整段匹配之后，再按公历校验月 01～12、日不超过当月天数，闰年规则正确（2000-02-29 收，1900-02-29、2025-02-29 不收）。年份 0000 也会放行，但值只有 ASCII 数字，不泄露信息，不用改。
- **S2 已解决**：坏值列表补上了 unicode 数字、全角数字、大写 id（两种写法）、前导空格、tag 末尾带 `\n` 和空格、`String` 对象，另加 5 条非法日期；resolve 也跑了整份列表；另有一条正例，核对真实日期照收。
- **S3 已解决**：文件头写明“tag 仍由前端按 kind、id、due_at 拼，不从 occurrenceKey 取”。
- 顺带看了 `logic.ts` 新加的 `at === 'resolve'` 分支：`snoozed` 只由 `remind_at`、`defer_until` 两个数字比较得出，没有引入新的输入来源，对负载的安全结论没有影响。
- 跑过：vitest 6 个文件 58 条全过（tests/shared/push、occurrence-key、edge 的 push-dispatch-occkey）；deno test 跑 push-payload-occkey，8 条全过。

### 撤回兜底约定（tag 和 occurrenceKey 任一对上就撤回）

**从安全角度看可以接受，撤不到别的条目、别的账号的通知。** 理由：
- 只有服务器能发推送（VAPID 签名、负载端到端加密），外人构造不出 resolve。
- 两种键都把本条的 kind、id 写在里面，而且服务器只放行和本条 kind、id 对得上的值，所以撤回的范围最多是“同一条日程、同一天、同一种当天或前一天提醒”的通知，不会波及别的条目。
- 唯一的放宽是：全天写法不看 due_at。所以同一次全天提醒在改了默认时刻以后又弹出的那条，也会一起被撤掉。这正是 R-336 定义的“同一次”，属于预期行为。
- 最坏情况是一条该显示的提醒被提前关掉（可用性问题），不涉及泄露，也不改数据。

**前端 A 实现时要守住四条**（作为第六节前提的补充，交给前端 A）：
1. 先按第六节第 1 条，用同一条白名单校验收到负载里的 occurrenceKey；校验不过就只比 tag。
2. 比较一律用全等，不用前缀、包含、正则匹配。比的对象是旧通知 `data` 里存着、经 `dataOf` 再校验过的 tag 或 occurrenceKey，并且要求 kind、id 也相同。
3. 只在负载的 `user_id` 和本机 owner 一致时才撤回（FE-1 的口径），而且只关本 App 显示的通知。
4. 撤回只关通知，不写 pending，不改数据，也不弹新的带标题的通知（resolve 照旧用本地固定文案）。
