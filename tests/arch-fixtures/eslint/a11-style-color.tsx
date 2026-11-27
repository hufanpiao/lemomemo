// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=lemo/no-inline-color message=A11 rule=A11
// 违规：style 里写死颜色
export const Bad = () => <p style={{ color: '#ff0000' }}>x</p>;
