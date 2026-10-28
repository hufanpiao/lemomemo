// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/motion-tokens message=A24 rule=A24
// 违规：style 里的 transition 写死时长和曲线
export const Bad = () => <div style={{ transition: 'opacity 200ms ease-out' }} />;
