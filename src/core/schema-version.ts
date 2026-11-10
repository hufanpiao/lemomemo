// 本机库的 schema_v（2.6：变了就整表重拉）：FA-6 ③ 从 shared/schema/rows.ts 抄一份到这里，
// 因为 rows.ts 带着 zod，boot.ts 在首屏上，只为一个数字把 zod 拉进首屏不划算。
// 真正的来源仍是 rows.ts 的 SCHEMA_V（改形状时在那边加 1）；两边不一致时 src/core/__tests__/schema-version.test.ts 失败
export const SCHEMA_V = 3;
