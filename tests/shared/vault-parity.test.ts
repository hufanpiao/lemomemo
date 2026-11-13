// 隐私记前后端各一份、不能互相 import 的常量逐个对照（服务器函数那边给 Vitest 测的模块不准引 _shared/gen/，见 _shared/b64url.ts 文件头）：
// • 令牌请求头名、有效期：supabase/functions/_shared/vault-token.ts ⇔ src/core/vault-token.ts、shared/schema/vault.ts
// • 推送事件：supabase/functions/_shared/push/payload.ts ⇔ src/sw/push-vault-data.ts（SW 按事件取本机语言的固定文案）
// 11-14 独立评审：这几样原来两边各写一份、没有核对。
import { describe, expect, it } from 'vitest';
import { VAULT_TOKEN_TTL_S as SHARED_TTL } from '../../shared/schema/vault.ts';
import { VAULT_TOKEN_HEADER as CLIENT_HEADER } from '../../src/core/vault-token.ts';
import { VAULT_PUSH_EVENTS as SW_EVENTS, VAULT_PUSH_TEXT } from '../../src/sw/push-vault-data.ts';
import { VAULT_PUSH_EVENTS as FN_EVENTS } from '../../supabase/functions/_shared/push/payload.ts';
import { VAULT_TOKEN_HEADER as FN_HEADER, VAULT_TOKEN_TTL_S as FN_TTL } from '../../supabase/functions/_shared/vault-token.ts';

describe('隐私记前后端两份常量一致', () => {
  it('令牌请求头名、有效期', () => {
    expect(CLIENT_HEADER).toBe(FN_HEADER);
    expect(FN_TTL).toBe(SHARED_TTL);
  });

  it('推送事件：两边同一组、同一顺序；SW 每个事件中韩文案都有', () => {
    expect([...SW_EVENTS]).toEqual([...FN_EVENTS]);
    for (const e of FN_EVENTS) for (const loc of ['zh', 'ko'] as const) expect(VAULT_PUSH_TEXT[loc][e].length).toBeGreaterThan(0);
  });
});
