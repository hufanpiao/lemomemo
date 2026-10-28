// arch-fixture: path=src/features/notes/index.ts expect=lemo/feature-index-exports
// 违规：index.ts 不准导出函数
export function helper(): number {
  return 1;
}
