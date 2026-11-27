// 邀请码格式（架构 5.6、15.3 第 8 条；10-30 负责人预览注册时输错一个字符、invite-signup 按设计悄悄回 {ok} 不发信）：
// 前端按和服务端同一份 32 个字符的字母表校验；输进 0、1、I、O（字母表里没有）时当场提示，不自动替换
// 服务端那份 supabase/functions/_shared/invite-code.ts 是 Deno 源码，前端不直接 import：这里读源码文本比对，两边改了一边就红
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INVITE_ALPHABET, INVITE_LEN, inviteHasConfusable, isInviteFormat } from '../data/auth-api.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

function serverConst(name: string): string {
  const src = readFileSync(join(ROOT, 'supabase', 'functions', '_shared', 'invite-code.ts'), 'utf8');
  const m = new RegExp(`export const ${name} = ([^;]+);`).exec(src);
  if (!m?.[1]) throw new Error(`invite-code.ts 里找不到 ${name}`);
  return m[1].trim();
}

describe('邀请码字母表和服务端一致', () => {
  it('INVITE_ALPHABET、INVITE_LEN 和 supabase/functions/_shared/invite-code.ts 逐字相同', () => {
    expect(serverConst('INVITE_ALPHABET')).toBe(`'${INVITE_ALPHABET}'`);
    expect(serverConst('INVITE_LEN')).toBe(String(INVITE_LEN));
    expect(INVITE_ALPHABET).toHaveLength(32);
    expect(new Set(INVITE_ALPHABET).size).toBe(32);
  });
});

describe('isInviteFormat：按字母表校验', () => {
  it.each(['ABCDEFGHJKMN', 'abcd-efgh-jkmn', ' 2345 6789 ABCD ', 'ZZZZ-9999-PQRS'])('正确的码：%s', (s) => {
    expect(isInviteFormat(s)).toBe(true);
    expect(inviteHasConfusable(s)).toBe(false);
  });

  it.each([
    ['含 0', 'ABCDEFGHJK0N'],
    ['含 O', 'ABCDEFGHJKON'],
    ['含 1', 'ABCDEFGHJK1N'],
    ['含 I', 'ABCDEFGHJKIN'],
    ['小写 o', 'abcdefghjkon'],
    ['小写 i', 'abcdefghjkin'],
  ])('%s：格式不过，标出易混字符', (_name, s) => {
    expect(isInviteFormat(s)).toBe(false);
    expect(inviteHasConfusable(s)).toBe(true);
  });

  it('位数不对、别的符号：格式不过，但不算易混字符', () => {
    expect(isInviteFormat('ABCDEFGHJKM')).toBe(false);
    expect(isInviteFormat('ABCDEFGHJKMNP')).toBe(false);
    expect(isInviteFormat('ABCDEFGHJKM!')).toBe(false);
    expect(inviteHasConfusable('ABCDEFGHJKM!')).toBe(false);
    expect(inviteHasConfusable('')).toBe(false);
  });
});
