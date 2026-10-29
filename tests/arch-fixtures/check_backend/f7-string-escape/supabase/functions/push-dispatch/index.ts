// 违规 F7（审查必改 1）：字符串、模板里的各种转义，下面每行一种
export const a = 'disabled\x5fat';
export const b = "\x53UPABASE_DB_URL";
export const c = 'fn\_vault';
export const d = `fn\u{5f}vault`;
export const e = `R2_${a}\u005fFN`;
export const f = 'FN_VAULT\
_DB_URL';
// 对照：\n \r \t \b \f \v \0 \\ \' \" \` \$ 不报
export const ok = ['a\nb\rc\td\be\ff\vg\0', '\\', '\'', "\"", `\``, `\${a}`];
export const g = 'R\62_FN';   // 八进制：本行报转义，解析器另在第 1 行报“解析不了”
