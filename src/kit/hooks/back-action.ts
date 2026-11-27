// 当前这一页的“‹ 返回”做什么（二级页从左边缘往右划的去处一律和点“‹ 返回”一样）：
// 页面左上角的返回按钮只有 kit 的 BackLink 一份，它挂上时把自己的 onBack 登记在这里、卸下时撤掉；
// 横滑（app/tab-swipe.ts）在二级页左边缘往右划时调最后登记、没禁用的那一个——划和点同一个函数，去处不另写一份。
// 最后登记的就是眼前这一页的：旧页卸掉以后才算换完页，换页动画里的旧页快照是拷出来的 DOM，不登记；
// 纪念日编辑层盖在列表上时，列表没有返回按钮。没有登记的（设置首页的“‹ 今天”是链接、电脑抽屉里没有返回按钮）由横滑自己按返回栈和 LEVELS 走
// 纯 TS，不引 React

export interface BackEntry {
  /** 点“‹ 返回”做的事 */
  run(): void;
  /** 按钮这时禁用着（注销页注销中）：划了也不动 */
  off(): boolean;
}

const entries: BackEntry[] = [];

/** BackLink 挂上时登记；返回撤销 */
export function registerBack(e: BackEntry): () => void {
  entries.push(e);
  return () => {
    const i = entries.lastIndexOf(e);
    if (i >= 0) entries.splice(i, 1);
  };
}

/** 眼前这一页的返回：最后登记的那一个；没有返回 null */
export function currentBack(): BackEntry | null {
  return entries[entries.length - 1] ?? null;
}
