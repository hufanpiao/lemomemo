// arch-fixture: path=src/features/notes/index.ts expect=lemo/feature-index-exports
// 违规：plusAdapter 只有 vault 能导出
export const plusAdapter = () => import('./plus-adapter.ts');
