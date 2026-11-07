# B2-UI-a 首屏瘦身（U7）独立安全审

- 审查人：独立安全审查员（只读，默认不通过）
- 日期：2026-11-07
- 范围：前端 B 的两处加载方式改动（工作区 git diff，基线 HEAD）
  1. 退出：新文件 `src/platform/exit-basics.ts`；`src/core/cache.ts`、`src/platform/account-status.ts`、`src/features/onboarding/data/consent-api.ts` 改从它引；`src/platform/sign-out.ts` 原样转出
  2. 服务工作者：新文件 `src/platform/sw-lifecycle.ts`；`src/platform/sw-register.ts`（loadSwLifecycle、registerServiceWorkerLazy、updateServiceWorkerLazy）；`src/app/main.tsx`、`src/platform/native-bridge.ts`
  3. 测试：`src/platform/__tests__/exit-basics.test.ts`、`sw-lazy.test.ts`、`src/core/__tests__/cache-delete-db.test.ts`、`sw-register(-update).test.ts`、`src/app/__tests__/first-paint-wiring.test.ts`、`tests/build/first-paint-graph.test.ts`
- 跑过：上述 8 个测试文件（含 sign-out.test.ts）85 条全过

## 结论

**有条件通过，8 / 10。** 退出这一半没有发现安全回退；服务工作者这一半有一处行为回退（下载超时后本次会话永远不注册），会影响推送认领和离线，要改。

## 一、退出（exit-basics.ts）

核对结果：

1. **逻辑没变**：withTimeout、deleteLocalDb、LOCAL_DB_NAME、DELETE_WAIT_MS 和 HEAD 里 sign-out.ts 的原文逐字一致；sign-out.ts 原样转出，测试钉住是同一个引用。
2. **首屏原来只用这几样**：`git grep` HEAD 时首屏里引 sign-out.ts 的只有 cache.ts（deleteLocalDb）、account-status.ts、consent-api.ts（withTimeout），三处现在都改从 exit-basics.ts 引。首屏从来不调 signOutThisDevice、defaultExitSteps、logoutReplaced 等退出本体；这些只在设置页、登录页（AuthPage、useSessionGate、useSessionExit、settings/data/*）里静态引，本来就跟那两页的分包走。所以“sign-out 分包没下载、下载失败”时能不能退，和改动前完全一样：进不了设置页就按不了退出（原有限制，不是本次引入）。
3. **会话失效、别的标签页退出、冷启动有库无会话**：走 core/cache.ts 的 deleteCacheDb → exit-basics.ts 的 deleteLocalDb，仍在首屏，不依赖任何分包，断网照常删库（本机操作）。
4. **推送认领清理**：push-disconnect.ts、exit-notice.ts 未改动，仍在首屏（S1、FA2-1 的约束保住）；它们不引 sign-out.ts。
5. **首屏绕过分包调 sign-out.ts**：src 里没有 `import(…sign-out…)`；first-paint-graph 新测试证明入口和首屏名单各动态入口的静态闭包都到不了 sign-out.ts，并有两条变异测试拦得住。没有发现首屏代码直接调用退出本体。
6. **离线退出**：signOutThisDevice 逻辑未改；新测试证明删行、signOut 都断网时照样清库、清 Cache Storage、兜底删本机会话。

无必改项。

## 二、服务工作者（sw-lifecycle.ts）

核对结果：

1. 搬走的 registerServiceWorker、watchServiceWorkerUpdate、checkSwOnForeground、updateServiceWorker 和 HEAD 原文一致；isTauri 判断仍在。
2. sw-register.ts 对 sw-lifecycle.ts 只有 `import type`，编译后擦掉；反向引 SW_URL 等常量，不形成首屏循环。
3. **离线可用**：预缓存清单（build/inject_sw_manifest.mjs）收录全部 chunk，已被 SW 接管的页面下载 sw-lifecycle chunk 走预缓存，断网照样拿得到；新 SW 激活前旧 chunk 不清理，426 时按“更新”用旧 chunk 不会 404。
4. **版本门**：426 / min 版本由服务器和同步引擎挡，和 SW 是否注册无关；“更新”拿不到模块回 failed，只会显示“更新失败”，不会被当成 reloading 或 no_update，**不能绕过版本门**。swReady 已为真时 failed 照旧重新载入（core/upgrade.ts 原逻辑）。
5. **换账号清理**：退订、推送断开走 push-disconnect.ts 和 Cache Storage 清理，不经 sw-lifecycle.ts，不受影响。
6. version_too_new 整屏提示前要等“下载 3 秒 + 注册 3 秒”，最坏 6 秒（原来 3 秒），不白屏但慢一倍，可接受，建议记录。

### 必改 M1：首屏后的注册被 3 秒下载超时截断，本次会话再也不注册

- 位置：`src/app/main.tsx` 第 233～245 行（`loadSwLifecycle().then(async (sw) => { if (!sw) return null; ... })`），`src/platform/sw-register.ts` 的 `loadSwLifecycle`。
- 问题：原来 `registerServiceWorker` 超时只是“不再等”，`navigator.serviceWorker.register` 照常进行，SW 晚到也会装上。现在超时发生在**下载代码**这一步：3 秒内 chunk 没回来就返回 null，之后 chunk 就算到了也没人调 register。首次打开、网络慢（首屏后同步那批代码同时在下载）时，本次会话：没有 SW、没有离线缓存、`runPushClaim()` 永远不跑（推送订阅不认领到这个账号）、`watchServiceWorkerUpdate` / `checkSwOnForeground` 都不挂，后台新版本提示也没有。注释和测试里说的“和注册失败同一条路”不成立。
- 改法（任选其一）：首屏后这条路不需要等，`loadSwLifecycle` 给这里传一个不超时的版本（或超时后 chunk 晚到仍照常注册、挂监听、触发推送认领）；只有 version_too_new 渲染前那次需要 3 秒上限。
- 补测试：模拟 chunk 在 3 秒后才到，断言 register、watchServiceWorkerUpdate、runPushClaim 仍会被调用（main.tsx 层面的接线测试或把这段抽成可测函数）。

### 建议 S1：“更新”拿不到模块时的退路

- 页面没被 SW 接管但已有旧注册（如强制刷新跳过 SW）时，chunk 走网络；若启动时那次下载失败，部分浏览器会缓存失败的动态 import，之后每次按“更新”都立刻 failed，用户只能手动重新打开。原来 updateServiceWorker 在首屏里，不存在这条路。概率低、不绕版本门，但会“卡在旧版本直到手动重开”。建议：拿不到模块时至少让 failed 的提示带“重新打开”，或保留一个极小的内联退路（getRegistration → waiting 时发 SKIP_WAITING）。

### 建议 S2：测试说明

- `exit-basics.test.ts` 的“③ 源码无 import(…sign-out.ts)”只认带 `.ts` 的写法；真正能防回退的是 first-paint-graph 的静态闭包测试，这条可以留作补充。
- “会话失效兜底”测的是 deleteCacheDb 本身，没有走 core/account.ts 的 wipeOnRemoved 调用链；因为调用链未改，可接受。
- 没有任何测试覆盖 M1 的“下载晚到”场景；sw-lazy.test.ts 只证明了 loadSwLifecycle 超时回 null，恰好证明了 M1 的行为。

## 三、补的测试是否证明了要求的几点

| 要求 | 是否证明 |
| --- | --- |
| 离线退出照样清本机 | 是（signOutThisDevice 断网用例） |
| 会话失效兜底删库 | 部分（deleteCacheDb 单测，未走调用链；调用链未改，可接受） |
| 首屏不进 sign-out.ts | 是（静态闭包 + 变异测试；源码正则为补充） |
| SW 下载失败 / 超时不抛、不白屏 | 是 |
| SW 下载晚到仍注册、推送仍认领 | **否**，且现状不满足（M1） |
| 版本门不被绕过 | 是（updateServiceWorkerLazy 回 failed；upgrade.ts 未改） |

## 复查（第二轮，2026-11-07）

范围：前端 B 针对 M1 的修改（`src/platform/sw-register.ts` 新增 `registerSwAfterPaint`、`src/app/main.tsx` 第 234～237 行、`src/platform/__tests__/sw-lazy.test.ts` 新增 3 条、`src/app/__tests__/first-paint-wiring.test.ts` 同步）、S2 的手册说明。复跑 7 个相关测试文件，70 条全过。

### 上一轮意见逐条核对

| 编号 | 上一轮意见 | 复查结果 |
| --- | --- | --- |
| M1 | 首屏后的注册被 3 秒下载超时截断，晚到不再注册，推送认领、离线、新版本监听都没了 | **已解决**。`registerSwAfterPaint` 直接 `await import()`，不设超时；只有 import 被拒才回 null。拿到模块后照原样 register → watchServiceWorkerUpdate → checkSwOnForeground，main.tsx 的 `swReg.then((reg) => { if (reg) void runPushClaim(); })` 不变。三元式条件（非开发、非 version_too_new）不变，接线测试钉住只调一处、在换账号闸之后。新测试用假时钟模拟 5 秒才到，断言 3 秒时还没注册、到了以后注册、两个监听、推送认领各调一次，正好覆盖上一轮指出的缺口；下载失败、注册失败两条也有。 |
| S1 | “更新”拿不到模块时的退路 | **未改，主持人定为遗留，挪到 B2-UI-b**。不绕版本门、概率低，接受作为遗留，B2-UI-b 需跟进。 |
| S2 | version_too_new 最坏 6 秒；测试说明 | **已解决**。注释已写；`docs/08-发布/上线与回滚手册-v4.md` 第 619～621 行写清 6 秒上限和排查办法。 |

### 新发现

- 无必改项。小提示（不阻塞）：`registerSwAfterPaint` 里 watch / check 若同步抛错，swReg 会 reject，main.tsx 的 `.then` 没接 catch，会变成一条未处理的拒绝；这两个函数现在都不会抛，可在 B2-UI-b 顺手加一个 `.catch(() => null)`。

### 复查结论

**通过，9 / 10。** M1 已修好且有测试证明；S2 已落文档；S1 按主持人决定作为遗留进 B2-UI-b（扣 1 分的原因）。
