# WebKit bug 草稿：新建 `<select>` 时误报 CSP style-src-attr

- 起草：前端 A，2026-11-05
- 状态：草稿，还没提交。提交到 https://bugs.webkit.org/ ，组件选 WebCore › Forms（或 Security）。
- 依据：
  - 第二节的独立复现页 11-05 已用 Playwright（`page.route` 给假域名返回带 CSP 的页面）跑过：WebKit 两种方式都报，Chromium 都不报；
  - `docs/03-评审/B2/B2-代码审查-FA7底栏外壳.md` 第四节（代码审查员查明来源）；
  - 前端 A 11-05 的 webkit 探针（Playwright 自带 WebKit 27.2，Windows）。
- 我们这边的处理：
  - CSP 不放宽；
  - `tests/e2e/csp-fixture.ts` 只对 webkit 精确放过这一种：style-src-attr、blocked = inline、来源是本站脚本，而且条数不超过挂进过文档的 select 个数；
  - 最小复现用例 `tests/e2e/csp-webkit-select.spec.ts` 在 webkit 下标了 `test.fail`。WebKit 修好以后，这条会变红，到时去掉 fixture 里的放过规则。
- 还没确认：真 iPhone 上的 Safari 是否也报。这一步已写进 `docs/00-团队/产品负责人待办-v4.md` 的 B2 验收（FA-7 之后），要接 Mac 用网页检查器看。

## 一、实测结论（中文）

| 实验 | WebKit 27.2 | Chromium |
|---|---|---|
| `document.createElement('select')`，不挂进文档 | 报 1 条 | 0 |
| 带 `<option>`、`multiple`、`size=4`、放在 `hidden` 的父元素里、`innerHTML` 插入 | 各报 1 条 | 0 |
| `<template>` 里解析 `<select>`（template 内容文档） | 0 | 0 |
| `textarea`、各种 `input`（date、time、range、checkbox、switch 等）、`details`、`meter`、`progress`、`dialog` | 0 | 0 |
| CSSOM 写样式：`el.style.setProperty(…, 'important')`、`el.style.display = …` | 0 | 0 |
| `startViewTransition` 期间写样式 | 0 | 0 |
| `el.setAttribute('style', …)`（真正的内联样式） | 报，应该报 | 报，应该报 |
| 第二节的独立复现页（只有 `style-src 'self'`；header、meta 两种都试） | 报 1 条 | 0 |

- 报的内容：
  - `violatedDirective` 是 `style-src-attr`，`blockedURI` 是 `inline`；
  - `sourceFile` 是调用 `createElement` 的那个脚本，我们这里是 React DOM 所在的公共块（名字是 `doc-locale-*.js`，和 `platform/doc-locale.ts` 无关）；
  - 控制台写的是“Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.”。
- 有 CSP 和没有 CSP 时，select 的 `offsetWidth`、`offsetHeight`、`display`、`appearance`、`padding` 完全一样：页面上没有任何东西被拦，只是多报了一条。
- 应用里任何一页只要渲染 kit 的 `Select`（目前是待办、日程编辑页），webkit 下就会报。直接打开 `#/todo/new` 也报：这一点和前端 B 最初的观察不同，用 `addInitScript` 最早挂上监听后确认。
- 推测原因：WebKit 给 `<select>` 建用户代理影子树（UA shadow root）时，里面的元素带了内联 `style` 属性，被当成页面的内联样式做了 CSP 检查。`template` 内容文档没有浏览上下文，不建影子树，所以不报。

## 二、提交用正文（英文，WebKit Bugzilla 只收英文）

**Title:** Creating a `<select>` element reports a spurious CSP `style-src-attr` violation

**Steps to reproduce**

1. Serve the following page with the response header `Content-Security-Policy: style-src 'self'` (a `<meta http-equiv="Content-Security-Policy" content="style-src 'self'">` policy reproduces it too):

```html
<!doctype html>
<meta charset="utf-8">
<title>select CSP repro</title>
<pre id="log"></pre>
<script src="repro.js"></script>
```

`repro.js`:

```js
const log = (s) => (document.getElementById('log').textContent += s + '\n');
document.addEventListener('securitypolicyviolation', (e) =>
  log(`violation: ${e.violatedDirective} blocked=${e.blockedURI} source=${e.sourceFile}`));
log('creating <select> (not inserted into the document)');
document.createElement('select');
setTimeout(() => log('done'), 200);
```

2. Open the page.

**Expected:** No CSP violation. The page does not set any inline style; creating a form control should not be subject to the page's `style-src` policy.

**Actual:** One `securitypolicyviolation` event (`violatedDirective = "style-src-attr"`, `blockedURI = "inline"`, `sourceFile` = the script that called `createElement`) and a console error "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy." are reported for **every** `<select>` created.

**Notes**

- Happens whether or not the element is inserted into the document, with or without `<option>` children, and for `multiple` / `size > 1` list boxes.
- Does not happen for `<select>` parsed inside a `<template>` (inert document).
- Does not happen for `<textarea>`, `<input>` of any type, `<details>`, `<meter>`, `<progress>`, `<dialog>`.
- The rendered `<select>` looks the same with and without the policy (same size and computed style), so the violation seems to come from styles WebKit applies inside the user-agent shadow tree, not from page content.
- Chromium does not report a violation for the same page.
- Impact: sites with a strict CSP that monitor violations (report-uri / report-to, or tests that fail on any violation) receive false reports on every page that renders a `<select>`.
- Reproduced with Playwright's WebKit build 27.2 on Windows. Not yet checked in Safari on iOS / macOS.

## 三、提交前要补的

1. 用真 iPhone 或 Mac Safari 复现一次，填进 Notes 的最后一条（见负责人待办 B2 验收那一行）。
2. 在 bugs.webkit.org 先搜一下有没有重复：关键词 `select CSP style-src-attr`、`user agent shadow root inline style CSP`。
3. 由负责人决定用谁的账号提交。提交后把 bug 号写回这里，同时写进 `csp-fixture.ts` 的注释。
