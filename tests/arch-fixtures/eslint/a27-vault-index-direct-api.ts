// arch-fixture: path=src/features/vault/index.ts expect=lemo/feature-index-exports message=A27 rule=A27
// 违规（架构 2.1 点名的样例）：vault 的 index.ts 直接导出 data 的函数，不经懒加载的适配器
export { unlock } from './data/vault-api.ts';
