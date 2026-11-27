// D1 第 12 节用：cron 命令里有没有写死的密钥（从 checks.ts 拆出来，max-lines）。
/**
 * cron 命令里像密钥的长串（0.38 第 46 条：命令里不能写死 ≥ 32 个字符的十六进制或 base64 串）：
 * 连续 32 个以上的 [A-Za-z0-9+/=_-]，同时有字母和数字（十六进制、base64、base64url 的随机值几乎一定两样都有；
 * 只有字母和下划线的长标识符不算）。返回第一个命中的串，没有返回 null
 */
export function cronHardcodedSecret(command: string): string | null {
  for (const m of command.matchAll(/[A-Za-z0-9+/=_-]{32,}/g)) {
    if (/[0-9]/.test(m[0]) && /[A-Za-z]/.test(m[0])) return m[0];
  }
  return null;
}