// 对照 A14（B1 K4 起）：前缀后面只有 16 个字符，短于 20，不算密钥；违规样例改看 a14-secret-prefixes。用低熵的 x，gitleaks 不报（.gitleaksignore 里对应的那一行留给历史提交 df16331）
export const key = 'sb_secret_xxxxxxxxxxxxxxxx';
