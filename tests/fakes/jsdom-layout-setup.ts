// vitest 全部项目的公共准备（vitest.config.ts 的 setupFiles）：jsdom 不排版，getClientRects 一律为空，
// “页面出来”的口径（motion/page-shown.ts 的 pageVisible：getClientRects 不为空）在 jsdom 里永远不成立。
// 这里按浏览器里 Suspense 藏旧页的样子补上：在文档里、自己和祖先都没有内联 display: none 就算显示着（量不出大小，给一个空矩形）。
// node 环境的项目没有 Element，什么都不做
if (typeof Element !== 'undefined') {
  Element.prototype.getClientRects = function (this: Element) {
    const hidden = !this.isConnected || this.closest('[style*="display: none"]') !== null;
    return (hidden ? [] : [new DOMRect()]) as unknown as DOMRectList;
  };
}
