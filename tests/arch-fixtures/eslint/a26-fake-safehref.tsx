// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/safe-href message=A26 rule=A26 count=2
// 违规：自己写同名的 safeHref / hrefOf 冒充，不是从 shared/logic/link.ts、src/app/router.ts 导入的不算
function safeHref(text: string) {
  return text;
}
const hrefOf = (text: string) => text;
export const Bad = ({ url }: { url: string }) => (
  <>
    <a href={safeHref(url)}>x</a>
    <a href={hrefOf(url)}>y</a>
  </>
);
