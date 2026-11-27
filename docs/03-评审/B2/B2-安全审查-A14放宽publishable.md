# B2 安全审查：check_arch A14 在 dist/web 放行 publishable key

日期：2026-11-03　审查：安全审查员　被审：运维　记录：主持人照审查员回报落盘（审查员只读）

## 背景
deploy-preview 在 12ba238（运行 41598819493）、ffcafa7（运行 41602504420）上都失败在“check_arch 扫预览产物”这一步。运维本机用假公开值复现：`错误 A14 dist/web/app/assets/doc-locale-*.js:9 疑似密钥特征：sb_publishable_ 密钥`。原因是仓库变量 `PREVIEW_SUPABASE_ANON_KEY` 是新格式 publishable key，构建时经 `VITE_PUBLIC_ANON_KEY` 有意编进网页；这条规则 B1 K4 就有，12ba238 起 deploy-preview 才在带真实变量的产物上跑。修法：`build/check_arch.py` 新增 `DIST_PUBLIC_OK = {"sb_publishable_ 密钥"}`，只在扫 dist/web 时跳过这一条；测试 `tests/arch/check-arch.test.ts` 新一条，样例 `tests/arch-fixtures/check_arch/a14-publishable-dist/`。

## 结论：通过，没有必改
1. 只跳过一条规则、只在 `top == "dist/web"`；同文件里 service_role、sb_secret_、sbp_、Google、Resend、PRIVATE KEY、VAPID_PRIVATE 照跑，JWK 私钥检查在循环外不受影响。
2. 别的密钥借这个前缀混不过去：各自认自己的前缀；把 secret key 填进 `VITE_PUBLIC_ANON_KEY` 仍会被 `sb_secret_` 拦。
3. src、shared 写死 publishable 照旧报（样例 `src/core/bad.ts`）。
4. publishable key 按设计是公开值，权限靠 RLS。

## 建议（不阻塞）
1. 只放行和本次构建 `VITE_PUBLIC_ANON_KEY` 完全相同的值，防环境串。
2. 补样例：同一 dist 文件同时有 publishable 和 secret，断言 secret 照报。
3. 早已存在的缺口：A14 不认旧格式 JWT（`eyJ…`）里的 service_role；可解 payload 查 `"role":"service_role"`。

## 跑过
`npx vitest run tests/arch/check-arch.test.ts` 17 条通过。

## 采纳情况（主持人，11-03）
建议 2 交运维随这次补上；建议 1、3 记入 B2 收尾再定。

## 代码审查（11-03，代码审查员，只读）
**签，9 / 10，没有必改。** 放行只在 `top == "dist/web"` 且规则名属于 `DIST_PUBLIC_OK`；名字和 `SECRET_PATTERNS` 拼出的 `f"{p} 密钥"` 一致，改名会失效报错（失败即关）；按规则逐条跳过、不按文件跳过；样例都是低熵假值，断言了退出码和准确位置。建议：补混合样例（主持人已补 `index-mixed.js`：publishable、sb_secret_、sbp_ 同一行，后两者照报）；可选加自检 `DIST_PUBLIC_OK <= {n for n, _ in SECRET_PATTERNS}`；排查说明写明预览变量误填 `sb_secret_` 时构建会失败。
