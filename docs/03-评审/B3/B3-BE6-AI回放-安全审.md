# B3 BE-6 AI 回放 安全审查

- 审查员：独立安全审查员（只读，默认不通过）
- 日期：2026-11-09
- 对象（未提交）：tests/ai/replay/recorder.ts、cassette.ts、replay.ts，tests/ai/replay/cassettes/ 下 8 个手写回放文件，tests/edge/ai-replay.test.ts。为了核对，还读了 .github/workflows/unit.yml 的 secrets-scan、.githooks/pre-commit、.gitleaksignore、vitest.config.ts。没有运行任何命令。

## 结论

**第二轮（2026-11-09）：通过，9 / 10，没有必改项。** 详见文末“第二轮复审”。

第一轮：**有条件通过，8 / 10。** 8 个手写回放文件和回放桩现在就可以合入；必改项 M1 改完之前，不准用录制器做任何真录制。

## 必改项

### M1 录制器会把录音原样存进回放文件

- 位置：recorder.ts 的 `bodyOf` 和 `record`。
- 问题：请求体整份解析后存盘。ai-voice 的请求体里有 `contents[].parts[].inlineData.data`，也就是整段录音的 base64（最大约 800 KB）。一旦真录语音，录音就会进回放文件、进公开仓库，违背 5.11 第 3 点和 A23 “录音只在内存、不落盘”的约定。录的哪怕是开发者自己的声音，也是不该公开的生物特征。
- 要求：
  1. 录制时把 `inlineData.data` 换成占位串（可以带上原长度和 SHA-256，方便核对），只留 mimeType；
  2. `leftovers` 加一条：发现 `inlineData` 里的 `data` 不是占位串就报 `audio`，`saveCassette` 拒绝存盘；
  3. 补一条单测：录一次语音请求，存盘结果里没有 base64 音频。

## 逐项核对

1. **请求头、密钥是否去干净。**
   - 请求头：录制器从头到尾不读 `init.headers`，回放条目只有 method、url、body 三个键，单测核对了键名，也核对了 `x-goog-api-key`、`set-cookie` 都没进文件。返回头也不存。
   - URL：`stripQuery` 只留 origin 和 pathname，查询串里的 `key=` 去掉了。
   - 正文里服务商回显的密钥：请求体和返回正文都先把录制时传进来的密钥原值换成 `[REDACTED]`，再把所有 `AIza` 开头的串换掉；`cassette()` 生成时又洗一遍。
   - AIza 以外的格式：Gemini 现在只用 API 密钥，按“原值替换”已经能覆盖任何格式，前提是调用方把原值传进来。不过 `saveCassette` 的 secrets 默认是空数组，忘了传就只剩 AIza 的样子检查（见建议 1）。原值是编过码以后才出现的（URL 编码、base64）不会被认出来；Gemini 不会这样回显，风险很低。
   - 不是密钥、但不该公开的东西：谷歌的错误正文常带 `consumer: "projects/<项目编号>"`、控制台链接等，会暴露 GCP 项目编号（见建议 2）。
2. **saveCassette 拒绝写盘能不能绕过。** 正常的录制流程绕不过：先查 `leftovers`（密钥原值、AIza 样子、`"headers":` 键、`x-goog-api-key` 字样），任何一项不过就抛错、不写文件，单测验证了“不干净不落盘”。能绕过的只有两种做法：调用方不传 secrets，或者直接用 writeFileSync 写文件。对后一种，仓库里还有“回放目录全部过 leftovers”的单测和 gitleaks 两道兜底。另外，`"headers"` 的检查认不出转义在字符串正文里的 `\"headers\"`，但那只是正文里的文字，不是真的请求头，不构成泄露。
3. **回放文件里有没有真数据、像密钥的串。** 8 个文件都标了 handmade，所有 `req.body` 都是 null，返回正文是“开会”“和老王聊合同”“明天下午三点开会”这类编的句子。地址里的模型名是占位的 gemini-x。逐个文件扫过 AIza、ya29.、eyJ、sk-、key=、projects/数字、邮箱、电话的样子，都没有。单测里的假密钥是运行时随机拼出来的，源码里不出现整串。
4. **gitleaks 那条测试能不能真拦住。**
   - 配置层面：单测钉住了 CI 的 secrets-scan 用默认规则扫全部历史（`--log-opts="--all"`、`--exit-code 1`），没有 `--config`、`--baseline`，没有 .gitleaks.toml，.gitleaksignore 不放行 tests/ai，pre-commit 也调 gitleaks、找不到 gitleaks 就拒绝提交。默认规则里的 gcp-api-key 能认出 AIza 加 35 位的串，所以真漏进来会被拦。
   - 行为层面：“往回放文件里塞一个假密钥，gitleaks 报退出码 1”这条用例用了 `it.skipIf(!hasGitleaks)`，本机装了 gitleaks 才跑，CI 的 unit 任务一律跳过（见第 5 条）。
5. **CI 会不会误跳过。** tests/edge/** 在 vitest 的 node 项目里，会被收录，除了上面那条 skipIf，其余用例在 CI 都会跑，不会被整组跳过。那条 skipIf 在 CI 的 unit 任务里每次都会跳，而且跳过时没有任何提示，所以“gitleaks 真能拦住回放文件”这件事在 CI 上只靠 secrets-scan 的配置在保证，没有行为上的证明（见建议 3）。

## 建议（不阻塞）

1. **secrets 改成必传。** `saveCassette` 和 `leftovers` 的 secrets 参数不要给默认值；`origin === 'recorded'` 时如果 secrets 为空，直接拒绝存盘，免得调用方忘了传、只剩 AIza 的样子检查。
2. **洗掉项目标识。** 存盘前把 `projects/\d+`、`consumer`、带项目 ID 的控制台链接也洗掉；另外规定：真录制只用测试集 ① 里编的句子，不用真实用户的话。
3. **CI 里补上行为证明。** 在 secrets-scan 任务（它装了 gitleaks）里加一步：造一个带假 AIza 的临时回放文件，执行 `gitleaks dir`，断言退出码是 1。或者让 unit 任务在 `CI=true` 又找不到 gitleaks 时直接失败，不要悄悄跳过。

## 第二轮复审（2026-11-09）

复审对象（未提交）：tests/ai/replay/cassette.ts、recorder.ts，tests/edge/ai-replay.test.ts、ai-replay-recorder.test.ts（新文件），.github/workflows/unit.yml 的 secrets-scan 任务。只读。唯一跑过的是一段本机 Python 模拟（只算熵，不碰网络、不碰仓库）。

**结论：通过，9 / 10，没有必改项。** M1 和建议 1～3 都已经落实。下面两点小的不准确和缺口不阻塞合入。

| 上一轮意见 | 复查结果 |
|---|---|
| M1 录音不落盘 | **已修好。** 录制器解析请求体后马上调 `stripAudio`，把所有 `inlineData.data` 换成 `[AUDIO len=<base64 字数> sha256=<64 位十六进制>]`，只留 mimeType。`data` 不是字符串的，`hasAudio` 会认出来、拒绝存盘；请求体不是 JSON 的，只存 `[non-json body]`，不存原文。`leftovers` 新加了 `audio` 一项。新单测用真的 GeminiProvider 录了一段 3000 字节的语音请求，核对存盘结果里只有占位串；把原始 base64 塞回去会报 `cassette_not_clean:…audio`。缺口（不阻塞）：只认驼峰写法的 `inlineData`，Gemini REST 接口也收 `inline_data`；我们的 gemini.ts 只发驼峰写法，所以现在没有漏，以后换写法要记得同步。 |
| 建议 1 secrets 必传 | **已落实，但和转述的说法不完全一样。** `saveCassette` 和 `leftovers` 的 secrets 都去掉了默认值；`origin = recorded` 时 secrets 为空或只有空串，`saveCassette` 抛 `cassette_no_secrets`，有单测。抛错的地方是存盘时的 `saveCassette`，不是录制器 `record()`：secrets 为空也能开录（会照样花钱），只是录完存不下来，不会泄露。如果想在花钱之前就挡住，可以让 `record()` 也查一次；不阻塞。 |
| 建议 2 洗掉 GCP 项目标识 | **已修好。** `projects/<编号或 ID>` 和 `?project=` / `&project=<ID>` 一律换成 `[REDACTED]`，没洗干净的 `leftovers` 报 `project_id`、拒绝存盘，单测用 PERMISSION_DENIED 正文验证过。另外检查了提示词里的 `</projects>` 标签：斜杠在 projects 前面，不会被误判。缺口（不阻塞）：Gemini 额度错误的正文里常见 `consumer 'project_number:<编号>'` 这种写法，现在的正则认不出来。项目编号不是密钥，建议顺手把 `project_number:\d+` 也加进去。 |
| 建议 3 CI 里补 gitleaks 行为证明 | **已落实，可靠。** secrets-scan 任务在扫历史之前，先用 Python `secrets` 随机生成一个 `AIza` 加 35 位（字母、数字、`-`、`_`）的假密钥，写进临时回放文件，跑 `gitleaks dir --exit-code 1`，退出码不是 1 就失败；临时目录用完即删；`set +e` / `set -e` 的写法正确；gitleaks 版本锁在 8.30.1（tools/ci-tools.lock），规则不会悄悄变。**关于熵不够导致误报失败的担心：** 我在本机按同一个字符表模拟了 20 万次，对整串 39 个字符算香农熵，最低 4.16，没有一次低于 4.0（gitleaks 的 gcp-api-key 规则门槛在 4 左右）。所以因为熵不够而误报失败的概率低于二十万分之一，可以不管。如果想彻底排除，可以在失败前换一个新假密钥再试一次：真没拦住时两次都会失败，不会掩盖问题。 |

上一轮另提的“真录制只用测试集 ① 里编的句子”，按主持人的安排由后端写进文档，这一轮不再跟踪。
