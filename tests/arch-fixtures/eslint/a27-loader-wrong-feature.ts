// arch-fixture: path=src/features/notes/index.ts expect=lemo/feature-index-exports message=A27 rule=A27
// 违规：loadTypeBar 只有 plus 能导出（受控例外，Q-24）
export const loadTypeBar = () => import('./ui/TypeBar.tsx');
