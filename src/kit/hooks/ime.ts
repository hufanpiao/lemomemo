// 输入法组字判断，全 app 只有这一份（改善报告 11-20 二-2、跨模块重复 高 3）：
// 中文、韩文输入法组字时按回车是选字、按 Esc 是撤掉候选，都不能当成“提交 / 打开结果 / 收起”。
// WebKit（iPhone、Mac Safari）组字时按的那一下 isComposing 可能是 false、keyCode 是 229，两样都要看。
// 单独一个小文件：kit Form（首屏）和层栈 layers.ts（不进首屏）都用它，放进哪一边都会把另一边拖进同一个包
/** 输入法组字中；React 事件传 e.nativeEvent */
export const composing = (e: { isComposing: boolean; keyCode: number }): boolean => e.isComposing || e.keyCode === 229;
