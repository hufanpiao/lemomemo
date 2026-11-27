# B0 验证：CSP 下的 Radix 与 Motion

- 日期：2026-10-28
- 做的人：前端程序员 A
- 依据：架构设计-v4 第 2.0 节“无障碍组件”一格（第七轮第二轮架构 N3）、1.3 B0 验收、8.1 `_headers`
- 结论一句话：**选做法 ①**——不用 Radix 的 `Dialog.Overlay`（里面的 react-remove-scroll 会插内联 `<style>`），遮罩自己画、滚动锁自己写；`style-src` 保持 `'self'`，**不需要 `'unsafe-inline'`，也不需要安全审查员签字**。Popover、Motion（进出场、按下回弹、layoutId 衔接）在 `style-src 'self'` 下没有任何报错。

## 怎么测的

| 项 | 内容 |
|---|---|
| 服务 | 项目里的 wrangler 4.154.0：`npx wrangler pages dev dist/web --ip 127.0.0.1 --port 8788`，读 `dist/web/_headers`（由 `src/_headers` 拼出） |
| 构建 | `npm run build -- --mode e2e`（Vite 8.3.5，生产构建，带 Service Worker） |
| 浏览器 | Playwright 1.64.1：chromium（桌面）、webkit（iPhone 15 模拟） |
| 判定 | 每个用例同时收两路：页面里的 `securitypolicyviolation` 事件，和控制台里含 “Content Security Policy / Refused to …” 的报错；**任何一条都判失败**（`tests/e2e/csp-fixture.ts`） |
| 页面 | App 首页 `/app/`（今天页）；CSP 试验页 `/app/#/dev-csp`（`src/app/dev/CspLab.tsx`，只在非正式版构建里挂） |
| 版本 | react 19.3.1、@radix-ui/react-dialog 1.3.1、@radix-ui/react-popover 1.3.1、motion 14.7.1 |
| 命令 | `npx playwright test`（20 个用例：18 通过、2 个按设计跳过，见最后一节） |

App 的 CSP（`/app/*`）：

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:;
connect-src 'self' wss://lemomemo.com; worker-src 'self'; font-src 'self'; manifest-src 'self';
frame-src 'self' https://view.officeapps.live.com; base-uri 'none'; form-action 'self';
object-src 'none'; frame-ancestors 'none'
```

（connect-src 的 ws 地址按构建模式替换：正式 `wss://lemomemo.com`、预览 `wss://preview.lemomemo.com`、本机 `ws://127.0.0.1:8788`。）

## 结果

| 用例 | chromium | webkit | 说明 |
|---|---|---|---|
| App 首页 | 通过，0 条 | 通过，0 条 | |
| Radix Dialog（kit 版：`src/kit/components/Dialog.tsx`） | 通过，0 条 | 通过，0 条 | 不用 `Dialog.Overlay`；遮罩是自己的 `<div>`；打开时 `<html>` 加 `scroll-locked`（样式在 `styles/base.css`），关闭后去掉；Esc 关闭、焦点锁定照常 |
| Radix Popover（`src/kit/components/Popover.tsx`） | 通过，0 条 | 通过，0 条 | Popover 定位用的是元素的 `style` 属性对象（CSSOM），CSP 不管 |
| Motion：`AnimatePresence` 进出场、`Pressable` 按下回弹、`layoutId` 衔接 | 通过，0 条 | 通过，0 条 | 用 `LazyMotion` + `m`；进出场用 `domAnimation`，layoutId 用 `domMax` |
| **对照组**：Radix 原样用法（带 `Dialog.Overlay`） | **被拦** | **被拦** | 两个浏览器都报 `style-src-elem`、`blockedURI = inline`，来源是打包进来的 react-remove-scroll（插 `<style>` 标签）。这一条证明上面的“0 条”不是因为没在查 |

被拦时页面本身还能打开、能关，只是 react-remove-scroll 的样式不生效（滚动没锁住），控制台每次打开报一条错。

## 选择和理由

架构 2.0 给的三条路：

1. **① 不用 Radix 的滚动锁，自己写**——采用。代价只有十几行（`useScrollLock`：计数支持弹层叠加，给 `<html>` 加 class）；Radix 的焦点锁定、Esc、读屏标注（`aria-modal`、`hideOthers`）都还在，因为这些在 `Dialog.Content` 里，不在 Overlay 里。
2. ② 换一个不插 style 的弹层库——不需要。
3. ③ `style-src 'unsafe-inline'`——不需要，也就不用走安全审查签字。

## 以后写代码要守的规矩

- **不准用 `Dialog.Overlay`**（Radix 的 AlertDialog、Sheet 一类同理，凡是内部用了 react-remove-scroll 的都一样）；弹层统一走 `kit/components/Dialog.tsx`。B1 起用 DropdownMenu 时，它的 `modal` 默认也会用 react-remove-scroll，**要传 `modal={false}`，或者同样包一层自己的滚动锁**——用到时在 `CspLab` 里加一项，跑一遍 `tests/e2e/csp.spec.ts`。
- **`AnimatePresence` 不准用 `mode="popLayout"`**（会插 `<style>`，架构 2.0 已禁）。
- 别的会插 `<style>` 的库（虚拟滚动、图表、Toast 库等）引入前先放进 `CspLab` 跑一遍。
- 改了 CSP 或加了第三方组件，`npx playwright test` 必须仍然 0 条 CSP 报错。

## 顺带查出来的两件事

1. **Pages 会把 `/app/preview.html` 308 重定向到 `/app/preview`**（wrangler pages dev 实测；Pages 的“去掉 .html 后缀”）。`_headers` 按请求路径匹配，所以预览沙箱那段要写 `/app/preview`（`.html` 那条也留着）。不改的话，真正返回页面的 `/app/preview` 只命中 `/app/*`，预览沙箱拿到的是主 App 的 CSP（`frame-ancestors 'none'`，App 自己也嵌不进去）。已改：`src/_headers` 两条都写；SW 的导航路由排除 `/app/preview` 和 `/app/preview.html`；e2e 用例检查 `/app/preview` 的 CSP。**前端 B4b-1 做预览沙箱时，iframe 的 src 写 `/app/preview`**。
2. **`! Content-Security-Policy` 在 wrangler pages dev 里有效**：`/app/preview` 只剩自己那条 CSP，没有和 `/app/*` 的叠在一起（用例断言里没有 `default-src 'self'`）。`/app/auth/*` 用的是同一写法，B1 建登录页时再加一条用例。

## 没做的

- “预览环境经自己的域名读写一条记录”（1.3 B0 验收第 2 条）：用例已写在 `tests/e2e/csp.spec.ts`，**跳过**。原因：要预览部署地址（`LEMO_E2E_PREVIEW_URL`）、前端 B 的 `/sb/*` 转发、后端的 events 表和 RLS 都到位，本机 `wrangler pages dev` 没有这些。由运维在预览部署后设上环境变量打开。
- 正式环境（真的 Cloudflare Pages）的响应头还没看过；运维第一次部署预览后，用 `curl -I https://preview.lemomemo.com/app/` 和 `/app/preview` 核对一次，结果补在这里。
