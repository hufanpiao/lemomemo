// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/safe-href message=A26 rule=A26
// 违规：src 不能拼字符串
export const Bad = ({ id }: { id: string }) => <img alt="" src={`/files/${id}`} />;
