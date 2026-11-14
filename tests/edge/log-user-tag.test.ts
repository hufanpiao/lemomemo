// 后端安全审查第 11 条：函数日志里认人统一成 _shared/log-tag.ts 的 logUserTag——
// HMAC-SHA256(服务器密钥, 'log-user:' + user_id) 的前 16 位十六进制，不可反查；没配密钥记 '-'（不记）。
// 原来 account-purge 的 short、invite-signup 的 orphan_user 记 user_id 前 8 位原文，account 的 userHash 是不加盐的 sha256（拿 user_id 一算就对上）。
// 密钥用已有的 SUPABASE_SERVICE_ROLE_KEY（三个函数都有；SIGNUP_HASH_SECRET 按 F1 只准 invite-signup、account-purge 读，account 读不到）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { logUserTag } from '../../supabase/functions/_shared/log-tag.ts';
import { A } from '../functions/account-fakes.ts';
import { requestDeletion, runPurge, world } from '../functions/account-purge-harness.ts';

const FN = join(import.meta.dirname, '..', '..', 'supabase', 'functions');
const src = (p: string) => readFileSync(join(FN, p), 'utf8');

describe('logUserTag（_shared/log-tag.ts）', () => {
  it('16 位十六进制、同一密钥同一人固定、换密钥就变、没有密钥回 -', async () => {
    const t = await logUserTag('k1', A);
    expect(t).toMatch(/^[0-9a-f]{16}$/);
    expect(await logUserTag('k1', A)).toBe(t);
    expect(await logUserTag('k2', A)).not.toBe(t);
    expect(t).not.toContain(A.slice(0, 8));
    for (const s of [undefined, '']) expect(await logUserTag(s, A)).toBe('-');
  });
});

describe('三个函数都用它', () => {
  it('account-purge：日志里是 logUserTag，不再有 user_id 前 8 位', async () => {
    const w = world();
    await requestDeletion(w, A);
    const pa = Date.parse(w.db.pending.get(A)?.purge_after ?? '');
    w.clock.ms = pa + 3600_000;
    const r = await runPurge(w, { userEmail: async () => null, logSecret: 'k1' });
    expect(r.logs).toContain(`remind_no_email:${await logUserTag('k1', A)}`);
    expect(r.logs.join('\n')).not.toContain(A.slice(0, 8));
  });
  it('源码：account-purge、invite-signup 不再截 user_id 前 8 位；account 的 userHash 用 logUserTag', () => {
    expect(src('account-purge/core.ts')).not.toMatch(/\.slice\(0, 8\)/);
    expect(src('invite-signup/core.ts')).not.toMatch(/orphan_user:\$\{[^}]*slice\(0, 8\)/);
    expect(src('account/index.ts')).toMatch(/userHash: \(uid\) => logUserTag\(key, uid\)/);
  });
});
