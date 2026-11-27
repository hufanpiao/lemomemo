// arch-fixture: path=src/core/bad.ts expect=no-restricted-syntax message=A12 rule=A12
// 违规：网络请求只能写在 platform（window.WebSocket 也算）
export const ws = () => new window.WebSocket('wss://example.invalid');
