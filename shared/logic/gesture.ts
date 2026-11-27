// 手势门槛和时长只在这里一份（代码结构审查 11-25 第 3 条）：shared 哪一层都能引（platform、kit、功能的 data 层、SW），
// 原来按分层引不到 motion/tokens.ts 的各处各写一份、注明“改一处要两处一起改”。数值照原样，手感不变。
// 还没收进来的：motion/ 目录里的 tokens.ts TAP_SLOP_PX（10）、long-press-drag.ts LIFT_MS（400）、long-press.ts SLOP_PX（8）——
//   那个目录这一批归另一路改，没动；以后改成引这里
// 纯常量：不 import 任何东西

/** 轻点和拖动的分界（px）：按下到抬手挪动不超过它算轻点，再远是在滑、在拖（底栏页签、打字条点空白处、看图点按、“＋”按住判定） */
export const TAP_SLOP_PX = 10;
/**
 * 更小的一档（px）：提醒横幅手指动了这么多就不算点按（设计 M1）。和 TAP_SLOP_PX 不一样大，
 * 要不要统一成一个数还没定（motion/long-press.ts 也用 8，没查到原因）；没定之前照原值留两个具名常量
 */
export const DRAG_SLOP_PX = 8;
/** 按住多久算“按住说话”（ms）：“＋”判按住、AI 聊天按得太短不上传，同一个数 */
export const PRESS_HOLD_MS = 350;
/** 长按（ms）：打字条按住这么久以上不拦（iOS 放大镜、选字）、吉祥物长按进 AI 助手 */
export const LONG_PRESS_MS = 500;
