// account-export-p0-auth.test.ts、account-export-p0-gaps.test.ts 共用（B1 QA 报告 6.2 节 E 组 P0 补测）：固定 id、造数据、
// 响应快照（状态码、体字节、头除 Date）、记调用顺序的 store 和 deps 覆盖项。
import { expect } from 'vitest';
import type { AccountStore, AuthResult } from '../../supabase/functions/account/core.ts';
import { A, accountDeps, type FakeDb, type Outbox } from './account-fakes.ts';
import { start, uid } from './account-export-harness.ts';

export const E1 = 'eeeeeeee-0000-4000-8000-0000000000e1';
export const S1 = 'aaaaaaaa-s1';
export const todos = (n: number, width = 200) => Array.from({ length: n }, (_, i) => ({ id: uid('33333333', i), user_id: A, title: 'x'.repeat(width) }));
export const SMALL = { exportLimits: { partRawBytes: 2048 } };

export async function startId(db: FakeDb, box: Outbox[], over: Parameters<typeof start>[3] = {}, headers: Record<string, string> = {}): Promise<string> {
  const r = await start(db, box, {}, over, headers);
  expect(r.status).toBe(200);
  return ((await r.json()) as { export_id: string }).export_id;
}

export type Snapshot = Awaited<ReturnType<typeof snapshot>>;

/** 一个响应的全部可比内容：状态码、响应体字节（十六进制）、响应头（去掉 date，按名字排序） */
export async function snapshot(r: Response): Promise<{ status: number; body: string; headers: string[][] }> {
  const body = Buffer.from(await r.arrayBuffer()).toString('hex');
  return { status: r.status, body, headers: [...r.headers].filter(([k]) => k !== 'date').sort(([x], [y]) => (x < y ? -1 : 1)) };
}

/** 包一层 store：每次调用按顺序记下名字（计数键记前缀，insertLog 记 act） */
export function recorded(store: AccountStore, seq: string[]): AccountStore {
  const tag = (name: string, args: unknown[]): string => {
    if (['takeRate', 'peekRate', 'refundRate', 'deleteCounterKey'].includes(name)) return `${name}:${String(args[0]).split(':')[0]}`;
    if (name === 'insertLog') return `insertLog:${(args[1] as { act: string }).act}`;
    return name;
  };
  return Object.fromEntries(Object.entries(store).map(([k, f]) => [k, (...a: unknown[]) => {
    seq.push(tag(k, a));
    return (f as (...x: unknown[]) => unknown)(...a);
  }])) as unknown as AccountStore;
}

/** 记调用顺序的 deps 覆盖项：authenticate、verifyVaultToken、store 都记进 seq */
export function tracing(db: FakeDb, box: Outbox[], seq: string[], tokenOk = false) {
  const base = accountDeps(db, box);
  return {
    authenticate: async (r: Request, o: { allowPendingDeletion: boolean }): Promise<AuthResult> => { seq.push('authenticate'); return base.authenticate(r, o); },
    verifyVaultToken: async (u: string, t: string) => { seq.push('verifyVaultToken'); return tokenOk && u === A && t === 'tok' ? ('ok' as const) : ('vault_locked' as const); },
    store: recorded(db.accountStore(), seq),
  };
}
