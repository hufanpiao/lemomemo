# ADR-017 前端用 React + TypeScript

- 状态：**已采纳**（2026-10-24，需求 R-96）
- 日期：2026-10-24
- 部分取代：[ADR-011](ADR-011-v4架构总则.md) 第 9 条（沿用 v3 原生 JS 分层的写法），以及[架构约定](../10-架构/架构约定.md)第 1–8 节对 4.0.0 的适用（它们只保留给 v3 和 3.0.1 只读版）
- 详细设计：[架构设计-v4](../10-架构/架构设计-v4.md) 0.14、第 2 节、8.1、第 9 节、第 17 节

## 背景
v3 是原生 JS，用 `App.x` 命名空间、文件头注释和 manifest 管依赖，靠手写 DOM 渲染。4.0.0 的页面、状态和交互多了很多（离线队列、冲突提示、录音面板、提醒横幅排队、隐私记、电脑三档布局、双语、动效），前端和 Edge Functions 还要共用逻辑和类型。产品负责人的决定：“v3代码本来就不多，重写的成本不考虑，看长期的话用哪个”；“用React + TypeScript”。

## 决定
1. **React**（B0 时的当前稳定大版本，锁精确版本）+ **TypeScript strict** + **Vite**。
2. **不用 Next.js**：纯静态 PWA 托管在 Cloudflare Pages，数据在本机 IndexedDB，打开先画本机数据再同步，不需要服务端渲染；官网首页是静态 HTML。
3. **路由**：自写轻量 hash 路由（`/app/#/…`），路由表集中在一处；页面超过约 15 个或需要嵌套数据加载时换 React Router 的 hash 模式。
4. **状态**：IndexedDB 是数据源，data 层（纯 TS）通过 `useSyncExternalStore` 接进 React；界面状态用 Zustand。
5. **多语言**：沿用自己的词典，改成 TS，键名和参数有类型检查；和 Edge Functions 共用。
6. **组件**：不用表单库（受控输入 + zod）；无障碍需要的弹层、菜单、开关按需引入 Radix Primitives（无样式）；样式用 CSS Modules + 皮肤变量（ADR-008 不变）。
7. **共享**：`/shared/` 放时刻函数、业务逻辑、词典、zod schema 和 `supabase gen types` 生成的数据库类型，前端（Vite）和 Edge Functions（Deno）共用。
8. **动效**：CSS 和原生 View Transitions 为主；弹簧、退出动画、元素衔接用 `motion/react`；全部集中在 `src/motion/`（R-93）。
9. **规则**：架构检查改成 ESLint + Stylelint + tsc + 小脚本；禁止 `dangerouslySetInnerHTML`、禁止 `any`；首屏 JS 压缩后 ≤ 150 KB（含 React）。
10. **测试**：Vitest（单元、契约）+ Testing Library（组件）+ Playwright（E2E，带 CSP）+ `deno test`。
11. v3 代码不迁移，只把算法和测试用例改写成 TS 沿用；v3 构建脚本只用来生成 3.0.1 只读版，之后归档。

## 后果
- 好处：类型检查覆盖前端、共享逻辑和服务器接口，改字段时编译器会指出所有受影响的地方；组件化以后复杂界面好维护，招人和用 AI 开发都更顺手；生态里的无障碍组件和动效库可以直接用。
- 代价：多了一套工具链（Node、Vite、ESLint、Stylelint、Vitest）；React 本身约 60 KB（gzip），首屏要靠代码分割守住预算；工期估算从 36–45 人日增加到 40–51 人日（主要是 B0 的脚手架）。
- 不受影响：服务器（Supabase、Edge Functions）、数据库、同步与冲突规则、安全设计、Tauri 方案 A（exe 加载远程 `/app/`）、官网首页。
