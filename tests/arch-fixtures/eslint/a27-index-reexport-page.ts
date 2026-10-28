// arch-fixture: path=src/features/notes/index.ts expect=lemo/feature-index-exports
// 违规：直接 export … from './ui/…Page'，会把整页带进首屏
export { default as NotesPage } from './ui/NotesPage.tsx';
