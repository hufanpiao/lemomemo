# B2 第 8 行动效自查（/review-animations，2026-11-04）

负责人本人调用 `/review-animations`，主持人按该 skill 的标准（Emil Kowalski 动效原则：十条硬标准、时长表、曲线）审 B2 第 8 行：Dialog 进出（UI-4 L-2）、Pressable 按下回弹（X-3 / C3）、减少动态效果（17.2 第 5 点、M5 单例）。只读，未改代码。

## 发现

| 改前 | 建议 | 原因 |
| --- | --- | --- |
| Dialog 弹层退场与进场同为 380ms（`src/motion/presets.ts` sheet，`tr.sheet`） | 退场缩到约 0.6～0.7 倍（约 240ms），进场保持 380ms | 进出不对称：用户主动关闭时系统应“快收”；380ms 在 200～500ms 抽屉区间内，不算违规，属打磨项 |
| 页面切换 `page` 380ms（`presets.ts` page，`--ease-standard`） | 维持，或试 300ms 对比 | 超过 UI 300ms 的一般上限；页面切换属于偶发、空间连续性用途，可以接受，建议真机慢放再看 |

## 已达标

- Pressable：按下 `scale(0.97)` + 120ms `--ease-out`，松开 `--ease-spring` 回弹，进出不对称、只动 transform，CSS 过渡可中断；切页前 `data-snap` 瞬间复位（C3）；减少动态效果时去掉缩放、改瞬时变淡，系统设置和 `data-rm` 两条都写了。
- Dialog：遮罩只淡入淡出 220ms `--ease-out`；内容 `translateY(100%)` 用百分比、`--ease-drawer`；关闭途中 `data-state="leaving"` 不接点按；Motion 动画可中断。
- 进场最小 `scale(0.95～0.98)`，没有 `scale(0)`、没有 `ease-in`、没有 `transition: all`、不动布局属性。
- 减少动态效果：只淡入淡出、时长减半，MotionConfig 兜底；判断单例化（一个 matchMedia + 一个 MutationObserver）。

## 结论

**通过（Approve）**：没有手感破坏、没有该删的动效，时长和曲线在范围内，可中断与减少动态效果都处理了。两条打磨项记进接手清单，FA-5 时一并处理。
