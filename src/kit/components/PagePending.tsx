// 页面级 Suspense 的占位：不画东西，只留一个隐藏标记，让整页过渡知道新页还没画完（motion/page-shown.ts 的 pageReady）。
// 只用在“整页内容”那一层（App 的页面、设置二级页），页内小块（头像、缩略图）照旧 fallback={null}，不然会白白多等。
// 属性名要和 page-shown.ts 的 PENDING_ATTR 一样（vt.test.ts 按这个名字测；kit 不能直接引 motion 内部文件，所以这里写死）
export function PagePending() {
  return <i hidden data-page-pending="" />;
}
