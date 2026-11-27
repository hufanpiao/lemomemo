// 调 invite-admin（架构 5.6 发码、第 6 节函数表 invite-admin 和“invite-admin 的错误码”；R-83：只有管理员能发码）
// • create {action: 'create', note?} → {code, expires_at}：12 位明文码只出现在这一次响应里（库里只存哈希），7 天有效、只能用 1 次，每人每天 20 次
// • list {action: 'list'} → {invites: [{id, note, max_uses, used_count, expires_at}]}：本人发过、还没过期的（含已用完的），不含码
// • revoke {action: 'revoke', id} → {ok: true}：作废一个还没用的（负责人 11-27），作废以后它和过期一样，list 不再列出
// • 一律经 platform/fn-call.ts 的 callFn；响应按 zod 认，认不出的当失败（bad_response）
// • 错误：服务器回 {error: 码}（同 ai-provider/data/provider-api.ts 的写法）：shared/schema/invite-admin.ts 里的码和共用的 bad_request 原样给出去，
//   401 和 unauthorized、account_* 一类归 signed_out，其余归 failed；没登录 no_session → signed_out；超时 timeout；断网 network → offline
// • 邀请码、备注只在这一次请求体和响应里，这里不记、不存、不进日志（运行日志由 hooks 记动作名和结果码）
// 纯 TS：不准 import React
import { z } from 'zod';
import { INVITE_ADMIN_ERROR_CODES, INVITE_NOTE_MAX, type InviteAdminErrorCode } from '../../../../shared/schema/invite-admin.ts';
import { callFn, defaultFnDeps, type FnDeps } from '../../../platform/fn-call.ts';

export const INVITE_ADMIN_FN = 'invite-admin';
/** 发码、读列表都只是一两条库操作：客户端等 10 秒（同 ai-provider 的读） */
export const INVITE_TIMEOUT_MS = 10_000;

export type InviteErr = InviteAdminErrorCode | 'bad_request' | 'offline' | 'timeout' | 'signed_out' | 'bad_response' | 'failed';
export type InviteResult<T> = { ok: true; value: T } | { ok: false; err: InviteErr };

const KNOWN: ReadonlySet<string> = new Set<string>([...INVITE_ADMIN_ERROR_CODES, 'bad_request']);
const SIGNED_OUT: ReadonlySet<string> = new Set(['unauthorized', 'account_disabled', 'account_pending_deletion', 'session_revoked']);

/** 服务器的码是 12 个大写字母和数字（字母表见 supabase/functions/_shared/invite-code.ts；这里只认形状，不再抄一份字母表） */
/** 时刻：create 回 toISOString()，list 回 Postgres timestamptz（“+00:00”、微秒），能被 Date.parse 认出就行 */
const when = z.string().refine((s) => !Number.isNaN(Date.parse(s)));
const createRes = z.strictObject({ code: z.string().regex(/^[A-Z0-9]{12}$/), expires_at: when });
const inviteRow = z.strictObject({
  /** 这一行的标识（code_hash 前 8 位，同一份里撞了的 16 位）：只用来作废这一行，不是码、反推不出码 */
  id: z.string().regex(/^[0-9a-f]{8}(?:[0-9a-f]{8})?$/),
  note: z.string().nullable(),
  max_uses: z.number().int().nullable(),
  used_count: z.number().int().nullable(),
  expires_at: when.nullable(),
});
const listRes = z.strictObject({ invites: z.array(inviteRow) });
const revokeRes = z.strictObject({ ok: z.literal(true) });

export type NewInvite = z.infer<typeof createRes>;
export type InviteRow = z.infer<typeof inviteRow>;

/** 服务器回的错误体 → 错误码 */
export function errOf(status: number, body: unknown): InviteErr {
  const code = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>)['error'] : undefined;
  if (typeof code === 'string' && KNOWN.has(code)) return code as InviteErr;
  if (status === 401 || (typeof code === 'string' && SIGNED_OUT.has(code))) return 'signed_out';
  return 'failed';
}

export interface InviteDeps {
  fn: FnDeps;
  signal?: AbortSignal;
}

const never = new AbortController().signal;

async function call<T>(body: Record<string, unknown>, res: z.ZodType<T>, d?: Partial<InviteDeps>): Promise<InviteResult<T>> {
  const r = await callFn(INVITE_ADMIN_FN, body, d?.signal ?? never, INVITE_TIMEOUT_MS, d?.fn ?? defaultFnDeps());
  if (!r.ok) return { ok: false, err: r.code === 'no_session' ? 'signed_out' : r.code === 'timeout' ? 'timeout' : 'offline' };
  if (r.status < 200 || r.status >= 300) return { ok: false, err: errOf(r.status, r.body) };
  const p = res.safeParse(r.body);
  return p.success ? { ok: true, value: p.data } : { ok: false, err: 'bad_response' };
}

/** 备注按 Unicode 码点数（和服务器 parseNote、Postgres 的 char_length 同一口径），先去首尾空白 */
export const noteLength = (note: string): number => [...note.trim()].length;
export const noteTooLong = (note: string): boolean => noteLength(note) > INVITE_NOTE_MAX;
export { INVITE_NOTE_MAX };

/** 发一个码：备注去首尾空白，空的不带；超过 40 个字当场回 note_too_long、不发（服务器也会挡，不计次数） */
export function createInvite(note: string, d?: Partial<InviteDeps>): Promise<InviteResult<NewInvite>> {
  const n = note.trim();
  if (noteTooLong(n)) return Promise.resolve({ ok: false, err: 'note_too_long' });
  return call(n === '' ? { action: 'create' } : { action: 'create', note: n }, createRes, d);
}

export function listInvites(d?: Partial<InviteDeps>): Promise<InviteResult<InviteRow[]>> {
  return call({ action: 'list' }, listRes.transform((v) => v.invites), d);
}

/** 作废一个还没用、还没过期的码（负责人 11-27）：成功以后这个码马上不能注册；已用掉、已过期、已作废回 not_found */
export function revokeInvite(id: string, d?: Partial<InviteDeps>): Promise<InviteResult<true>> {
  return call({ action: 'revoke', id }, revokeRes.transform(() => true as const), d);
}

/** 显示用：4 位一组、横线连（“K7Q2-M9XD-4TPA”，同线框；注册页 normalizeInvite 会去掉横线，复制过去照样能用） */
export function groupInvite(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

/** 这个码用完了没有（used_count ≥ max_uses；读不出来的当没用） */
export const usedUp = (r: InviteRow): boolean => r.used_count !== null && r.max_uses !== null && r.used_count >= r.max_uses;

/** 能不能作废：次数读得出来、还没用完（列表里本来只有没过期的；过期、被占的那一刻由服务器判，回 not_found） */
export const revocable = (r: InviteRow): boolean => r.used_count !== null && r.max_uses !== null && r.used_count < r.max_uses;
