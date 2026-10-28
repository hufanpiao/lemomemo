// arch-fixture: path=src/features/notes/index.ts expect=lemo/feature-index-exports
// 违规：值导入自己的 ui，再放进路由表
import NotesPage from './ui/NotesPage.tsx';

export const routes = [{ name: 'notes', Page: NotesPage }] as const;
