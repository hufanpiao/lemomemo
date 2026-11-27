# B2-UI-a 前端 A → 前端 B 接口说明

- 日期：2026-11-07　写的人：前端 A
- 依据：[B2-UI-a 任务单](../../09-路线图/B2-UI-a-任务单.md) 第三节“约定 1”。前端 B 用下面这些，不改 `tokens.json`、`Form.*`；要新令牌、新外观找前端 A。

## 1. 新令牌（`tokens.json` → `python build/tokens.py` 生成）

| 令牌 | 取值 | 用在哪 |
|---|---|---|
| `--inp-bg` | 四套皮肤都是 `var(--panel-2)` | 全站输入框底色（表单、提醒时刻框、登录框） |
| `--r-inp` | `var(--r-md)`，即 14px（视觉稿第 978 行） | 全站输入框圆角；有框输入框的聚焦框跟着它 |

## 2. `--focus` 新取值（R-351，负责人 11-07 定）

每套皮肤填和该皮肤 `--text` 相同的字面色值：简洁浅色 `#141518`、简洁深色 `#F2F3F5`、玻璃浅色 `#141518`、玻璃深色 `#F1F2F4`。各文件的 `var(--focus)` 引用一律不动，底栏和“＋”自动跟着变。以后 `--text` 改了要同步改 `--focus`（令牌说明里写了）。

## 3. `FormButton`（`src/kit/components/Form.tsx`）

```ts
export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'dangerFill' | 'ghost';
FormButton(props: Pressable 的属性（不含 className） & { variant?: ButtonVariant; danger?: boolean })
```

- 不写 `variant` 是 `secondary`（描边）；老写法 `danger`（布尔）等于 `variant="danger"`。
- `primary`：`--accent` 实底、`--on-accent` 字（“该你动手”的主操作，一屏最多一个）；`dangerFill`：危险底色（确认框）；`ghost`：细线描边。
- 高度一律 `--hit`（44），圆角胶囊，聚焦框 `--focus`。
- `strong`（布尔）：字重 600（代码审 M2）。`primary`、`dangerFill` 本来就是 600；`secondary`、`danger`、`ghost` 默认 400（编辑页“删除”“清掉”），设置 › 提醒的“重新连接”“移除它…”“取消”传 `strong`，保持原来的 600（主持人 11-07：任务单只允许颜色变，字重不变）。
- **设置页的按钮本批不换成 FormButton**（代码审 M3，主持人 11-07：U3-3 整体挪到 B2-UI-b）：“退出这台设备”“退出其他所有设备”和弹窗里的按钮按 R-276、R-277 是**看得见 38 高、`--panel-2` 实底、`::after` 把点击区扩到 44**（`SettingsPage.module.css` 的 `.btn`，`ConfirmDialog`、`DataSection`、`DesktopSection`、`DevicesSection`、`RecentExport` 都在用）。FormButton 每种都是看得见 44、`secondary` 是描边，换过去会改掉负责人定过的外观，所以这些按钮继续用 `.btn`。B2-UI-b 要统一时，先给 FormButton 加一个合 R-276、R-277 的紧凑尺寸，再换。

## 4. 返回按钮统一写法（U3-6）

前端 A 已用在 `EditShell.module.css` 的 `.back`、`Remind.module.css` 的 `.back`（整页提醒）。前端 B 把下面这段照抄到 `SettingsPage.module.css` 的 `.back`（`:28`）、`.backBtn`（`:335`）和 `RecentlyDeletedPage.module.css` 的 `.back`（`:18`），类名用各自原来的，不挪位置。“‹”写成 `<span aria-hidden="true">‹</span> 文字` 或 `‹ 文字`（编辑页现在是后者），字号、颜色、点击区一样。

```css
/* 返回按钮统一写法（B2-UI-a U3-6）：“‹ 文字”15px 正文色、按钮自己的字体（font: inherit）；左边不留内边距，字和下面正文左边对齐；
   点击区不够 44 × 44 的用 ::after 以按钮中心外扩（同 Settings.module.css 的 .segBtn::after），不挪位置 */
.back {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-self: start;
  min-height: var(--hit);
  padding: 0;
  border: 0;
  background: none;
  color: var(--text);
  font: inherit;
  font-size: var(--fs-15);
  text-decoration: none;
  cursor: pointer;
}

.back::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: max(100%, var(--hit));
  height: max(100%, var(--hit));
  transform: translate(-50%, -50%);
}

.back:focus-visible {
  border-radius: var(--r-sm);
  outline: 2px solid var(--focus);
  outline-offset: 2px;
}
```

## 5. 完成圆圈（`CheckCircle`，U4-4）

- 外层从 `span` 改成 `label`，`.checkBox::after` 把点击区外扩到 44 × 44（圆圈本身 22 × 22 不变），聚焦框改 `--focus`。列表行里圆圈和标题之间要留够间距，外扩区不要盖到标题按钮上（列表行归前端 B，量数 spec 里一起量）。
- 编辑页“已完成”用 `<Check look="circle">`，和列表圆圈同一画法、同一动效。
