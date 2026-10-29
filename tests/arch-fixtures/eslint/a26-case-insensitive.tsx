// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/safe-href message=A26 rule=A26 count=8
// 违规：链接属性名换大小写也算（React 只拦写法完全正确的 href、formAction，别的大小写原样落到 DOM）
export const Bad = ({ u }: { u: string }) => (
  <>
    <a {...{ HREF: u }}>a</a>
    <button {...{ formaction: u }}>b</button>
    <img alt="" {...{ srcset: u }} />
    <svg>
      <use {...{ 'xlink:HREF': u }} />
      <use xlink:HREF={u} />
    </svg>
    <a HREF={u}>c</a>
    <button formaction={u}>d</button>
    <img alt="" SRC={u} />
  </>
);
