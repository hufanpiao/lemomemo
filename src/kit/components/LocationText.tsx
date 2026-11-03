// 地点 / 链接的正式组件（架构 5.9“地点 / 链接”，R-69；SAFE-link-real，TC-B1-32 后半、TC-B2-02）：
// 整段文字能过 shared/logic/link.ts 的 safeHref（只放行 http、https、tel、mailto，不带用户名密码）才渲染成 <a>，
// 否则当普通文字；打开时 rel="noopener noreferrer"。不用 innerHTML（A22）。整页提醒、日程编辑页共用
// • 打开方式（R-301；B6-exe 安全审查 F5-5）：
//   - exe：点击时交给系统浏览器（kit/hooks/useOpenLink.ts → Rust 的 open_external，四种协议都行），不走 target=_blank、不走页面跳转；
//   - 网页：http、https 新窗口打开；mailto、tel 不带 target=_blank，交给顶层导航（拉起邮件、电话程序，不留空白新窗口）
import { safeHref } from '../../../shared/logic/link.ts';
import { linkClickHandler } from '../hooks/useOpenLink.ts';

const NEW_WINDOW = /^https?:/i;

export function LocationText({ text, className }: { text: string; className?: string }) {
  // href 属性上直接写 safeHref(text)（A26 只认这个调用）；这里的 href 只用来判断协议、交给点击处理
  const href = safeHref(text);
  if (href === undefined) return <span className={className}>{text}</span>;
  return (
    <a
      className={className}
      href={safeHref(text)}
      target={NEW_WINDOW.test(href) ? '_blank' : undefined}
      rel="noopener noreferrer"
      onClick={linkClickHandler(href)}
    >
      {text}
    </a>
  );
}
