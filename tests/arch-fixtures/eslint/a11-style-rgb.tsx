// arch-fixture: path=src/kit/components/Bad.tsx expect=lemo/no-inline-color
// 违规：style 里写 rgb()
export const Bad = () => <p style={{ background: 'rgb(0 0 0 / 50%)' }}>x</p>;
