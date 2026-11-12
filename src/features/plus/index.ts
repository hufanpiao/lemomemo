// 功能 plus：“＋”统一入口：记录状态机、AI 退路、录音面板、打字条、意图结果卡片、总结
// 对外唯一入口（架构 2.1、A27）：只导出懒加载的页面、登记项、类型和清单引用；别的功能只能 import 这个文件
// 首屏体积（B3 Q4）：这个文件经 app/features.ts 进首屏，所以只放 lazy；打字条那一块首屏画完以后才预先下载（app/plus-slot.tsx）
import { lazy } from 'react';

export const routes = [] as const;

/**
 * 打字条（B3 FA-2）：“＋”点一下打开。下载打字条那一块，拿到组件本身（app/plus-slot.tsx 首屏画完以后先调）。
 * 不用 lazy：lazy 第一次渲染总要挂起一拍，React 19 再把内容压后约 300ms 才放出来，聚焦就不在点按的那一下里，
 * iOS 不弹键盘（Q-24）。下载好以后 plus-slot 直接画组件，打开的那一次渲染当场画出、当场聚焦。
 * props: { day: 日历页选中的那天或 null; onExpand(text, day): 展开成完整新建页; onEdit?(table, id): 提示条里“修改”某一条; onClose() }
 * 同一块里还有 Preload（“＋”上方的小气泡 B3 S23、按住“＋”录音那一套 B3 FA-3，下载好以后 plus-slot 一直挂一份）和 hold（按住“＋”的手势，
 * plus-slot 接到 GlassBar 的转发桥上）：不单独 import，首屏的预加载表只有打字条这一处，录音那一套不往首屏添文件名（首屏额度只剩约 90 B）
 */
export const loadTypeBar = () => import('./ui/TypeBar.tsx');

/**
 * 设置 › 语音与 AI、在 Claude 聊天里记事（B3 FA-4，主持人 11-09 定方案 a：只多这一个懒加载导出）。
 * props: { part: 'voiceAi' | 'claude'; view: 'value'（设置首页那一行右边的值）| 'page'（二级页正文） }
 */
export const PlusSettings = lazy(() => import('./ui/PlusSettings.tsx'));

