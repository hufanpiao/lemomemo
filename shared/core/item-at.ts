// 按下标取数组元素的共用小函数（农历 lunar.ts、黄历 lunar-huangli.ts 共用；R-431 独立评审第 4 条）
// • 下标不是非负整数就返回 undefined
// • 不用方括号下标（check_backend F7：shared 拷进 Edge Functions 后，方括号里的键不许是参数、属性或算出来的数）；
//   也不直接用 .at()，因为 .at() 遇到负数会从末尾倒着取，表前面的年份会错拿到最后一年
export function itemAt<T>(arr: readonly T[], i: number): T | undefined {
  return Number.isInteger(i) && i >= 0 ? arr.at(i) : undefined;
}
