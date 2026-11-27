// exe 快速记录小窗口的词条·中文：只有这个小窗口用，不进公共词典。加一条要同时加 quick-add-ko.ts
export const quickAddZh = {
  label: '快速记录',
  placeholder: '写一句，按 Enter 记下',
  hint: 'Enter 记下 · Esc 收起',
  failed: '没交上去，内容还在，再按一次 Enter',
  // 待取队列攒满（main 一直没来取：主窗口没开、没登录）：再按也交不上，先叫用户打开主窗口
  full: '前面交的还没记进柠檬记，先打开柠檬记主窗口（没登录先登录），这句还在',
  tooLong: '太长了，一句最多 2000 字，删掉一些再按 Enter',
} as const;

export type QuickAddMsgKey = keyof typeof quickAddZh;
