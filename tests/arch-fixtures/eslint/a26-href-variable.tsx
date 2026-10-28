// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/safe-href message=A26 rule=A26
// 违规：href 不能是任意表达式（要经 safeHref）
export const Bad = ({ url }: { url: string }) => <a href={url}>x</a>;
