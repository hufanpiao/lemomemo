// 冲突副本标题的后缀（K8 实现方案第九节；韩文审校第三节第 1 点：韩文前面一个半角空格、半角括号，共 8 个字符）。
// 服务器 public.apply_patch 在 forked 时按本人的 profiles.ui_locale 选（迁移 20261105100000 里写同样的字面量，
// tests/build/fork-suffix-sql.test.ts 逐字比对）；ui_locale 取不到或不认识的按 zh-CN。
// 前端假服务器、forked 说明从这里取，不要另写一份。
/** 冲突副本标题的后缀：服务器 apply_patch 按 profiles.ui_locale 选（SQL 里写同样的字面量，测试逐字比对） */
export const FORK_SUFFIX = { 'zh-CN': '（冲突副本）', 'ko-KR': ' (충돌 사본)' } as const;
