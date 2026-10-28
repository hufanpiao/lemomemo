// arch-fixture: path=src/kit/hooks/bad.ts expect=no-restricted-syntax message=A13 rule=A13
// 违规：navigator.serviceWorker 只能写在 platform
export const reg = () => navigator.serviceWorker.getRegistration();
