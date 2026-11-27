// 违规样例的引用目标（不是样例本身，没有 arch-fixture 文件头）：假装是 calendar 功能的 data。
// 现在仓库里还没有任何功能的 data/ 文件，引不存在的路径时 ESLint 的边界规则认不出类型、不报（QA 改坏抽查 4b），
// 所以放一个真文件给 tests/arch-fixtures/eslint/a1-data-imports-other-feature-data.ts 引
export const listEvents = (): readonly string[] => [];
