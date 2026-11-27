// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/safe-href message=A26 rule=A26 count=2
// 违规：原生元素上展开变量（{...props}），静态看不出里面有没有 href，一律报（从严）
export const Bad = (props: { href: string }) => (
  <>
    <a {...props}>x</a>
    <img alt="" {...{ ...props }} />
  </>
);
