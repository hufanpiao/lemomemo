// arch-fixture: path=src/features/plus/ui/Bad.tsx expect=boundaries/dependencies
// 违规（架构 2.1 点名的样例）：plus 直接 import notes 的 ui，不经 notes 的 index.ts
import NotesPage from '../../notes/ui/NotesPage.tsx';
export const P = NotesPage;
