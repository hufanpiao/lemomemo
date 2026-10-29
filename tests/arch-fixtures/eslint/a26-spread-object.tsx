// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/safe-href message=A26 rule=A26 count=3
// 违规：原生元素上用对象字面量展开带 href / src，同样要经 safeHref；键名算不出来的也报
export const Bad = ({ url, k }: { url: string; k: string }) => (
  <>
    <a {...{ href: url }}>x</a>
    <img alt="" {...{ 'src': `/files/${url}` }} />
    <a {...{ [k]: url }}>y</a>
  </>
);
