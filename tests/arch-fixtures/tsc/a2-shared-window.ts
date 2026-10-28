// arch-fixture: expect=TS2304
// 违规：shared 的 tsconfig 不含 DOM，用 window 编译不过（用 tsconfig.shared.json 的选项编译）
export const w = window.location.href;
