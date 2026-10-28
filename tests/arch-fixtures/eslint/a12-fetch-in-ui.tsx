// arch-fixture: path=src/features/notes/ui/Bad.tsx expect=no-restricted-globals
// 违规：网络请求只能写在 platform
export const load = () => fetch('/x');
