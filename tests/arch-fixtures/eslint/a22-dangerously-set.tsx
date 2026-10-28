// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=react/no-danger
// 违规：没有例外地禁止 dangerouslySetInnerHTML
export const Bad = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;
