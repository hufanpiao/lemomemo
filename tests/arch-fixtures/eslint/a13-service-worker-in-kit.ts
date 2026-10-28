// arch-fixture: path=src/kit/hooks/bad.ts expect=no-restricted-syntax
// 违规：navigator.serviceWorker 只能写在 platform
export const reg = () => navigator.serviceWorker.getRegistration();
