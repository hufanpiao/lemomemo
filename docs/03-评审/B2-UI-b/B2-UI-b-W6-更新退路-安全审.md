# B2-UI-b W6 更新拿不到模块时的退路 安全复审

- 审查员：独立安全审查员（只读，默认不通过）
- 日期：2026-11-09
- 对象（未 git add）：src/platform/sw-register.ts（`freshLifecycleUrl`、`importLifecycleFresh`、`skipWaitingDirect`、`updateServiceWorkerLazy`）；测试 src/platform/__tests__/sw-lazy.test.ts、src/app/__tests__/sw-update-fallback-busy.test.ts、tests/e2e/b2-ui-b-update-fallback.spec.ts。为了核对调用方，还读了 src/core/upgrade.ts、src/platform/native-bridge.ts（这两个文件这次没改）。
- 依据：首屏瘦身安全审 S1；负责人 R-364 D3（B2-UI-b 任务单架构审第 76 行）。

## 结论

**通过，9 / 10，没有必改项。** 前端 B 列的 4 条安全要点逐条核实，都成立。

## 逐条核实

1. **不绕开版本门：成立。**
   - `SwUpdateResult` 类型没改；退路只会回已有的 `'reloading'` 或 `'failed'`，没有新增返回值。
   - `git diff` 里 core/upgrade.ts、native-bridge.ts 都没改，调用方的判断原样保留。
   - 版本门（426）由服务器说了算，客户端这条退路能做的只是“换成新版本”，没法让旧版本躲过 426。
2. **SKIP_WAITING 只发给本 scope 的 waiting，而且 scriptURL 整串相等：成立。**
   - `skipWaitingDirect` 只取 `getRegistration('/app/')` 那一个注册的 `waiting`。
   - `scriptURL !== location.origin + '/app/sw.js'` 就不发：别的源、别的路径、带查询串的都不认，单测三种情况都覆盖了。
   - 拿注册出错一律回 false。
   - 发的消息内容是写死的 `{type: 'SKIP_WAITING'}`，不带任何数据。
3. **换地址只认同源、地址取自本模块打包后的源码：成立，没有可利用的注入点。**
   - 取地址：`importLifecycle.toString()` 拿到的是打包产物里这个函数自己的源码，是编译时就定死的常量，不读 URL、存储、消息、网络返回这些外部输入。要改它，得先能改我们自己的脚本，那时候早就失守了；何况页面 CSP 不许外来脚本，别的代码也改不了 `Function.prototype.toString`。
   - 解析：正则只取第一个 `import(…)` 括号里的字面量（三种引号都认，排除 `$`，所以模板字符串里的 `${}` 插值不会被取出来），用本模块自己的 `import.meta.url` 当 base 解析。
   - 同源：解析后必须和 base 同源，`https://evil…`、协议相对的 `//evil…`、`data:`、`blob:`（这两种的 origin 是 "null"）都会被拒，单测里有 evil 和取不到两种。
   - 取错地址怎么办：如果以后打包把地址变成变量、或者换了包装函数，正则取不到就回 null、Promise 被拒，接着走退路 ②，最差就是回 failed，不会去下载别的东西。e2e 在真实构建产物（`/app/assets/sw-lifecycle-*.js`）上验证了带 `?r=` 的请求确实发出并拿到 200，说明当前打包下取到的是对的地址。
   - 加的查询串只有 `r=<时间戳>`，不带任何用户数据；同源脚本带查询串仍符合 CSP 的 `script-src 'self'`。
4. **退路自己不重新载入：成立。**
   - `updateServiceWorkerLazy` 只返回结果，代码里没有 `location.reload`。
   - 什么时候载入由 upgrade.ts 的 `reloadWhenIdle` 决定：还有没作废的忙碌令牌（编辑中、录音等）就先挂起，空闲了才载入。sw-update-fallback-busy.test.ts 覆盖了“忙的时候不载入”。
   - 每次载入都要用户先按“更新”，不会自动循环。“刚按过更新”的会话标记 `lemo.update_attempt` 在 sessionStorage 里，只存版本号，不含账号信息。

## 建议（不阻塞）

1. **退路 ② 发完 SKIP_WAITING 马上回 `reloading`，没等新 SW 真的接管。** 主路径会等接管、超时回 `takeover_timeout`。如果这时候页面空闲马上载入，可能还没切过去，载入后仍是旧版本，用户会看到“仍不够新”，要再按一次。这不是安全问题，只是体验；可以在发完以后等一下 `controllerchange`（比如最多 3 秒），超时就回 `takeover_timeout`，和主路径保持一致。
2. **换地址那次下载会生成第二份 sw-lifecycle 模块实例**（地址不同，浏览器当成两个模块）。现在只在第一份根本没拿到时才用，不会两份同时存在；以后如果给 sw-lifecycle 加模块级的状态，要记得这一点。
