// 隐私记会话测试共用的桩：假 VaultApi（和服务器一样只收已保存隐私记的图）、注入时间的 make、手动放行的 held、已解锁的 unlocked
import { expect, vi } from 'vitest';
import type { z } from 'zod';
import type { VaultNote, VaultRequest } from '../../../../shared/schema/vault.ts';
import { createVaultSession } from '../data/session.ts';
import type { VaultApi, VaultFail, VaultResult } from '../data/vault-api.ts';

export const TOK = 't'.repeat(32);
export const TOK2 = 'u'.repeat(32);
export const NID = '11111111-1111-4111-8111-111111111111';
export const IMG = '22222222-2222-4222-8222-222222222222';
export const note = (over: Partial<VaultNote> = {}): VaultNote => ({
  id: NID, title: '体检报告', body: '血压 120/80', category_id: null, created_at: 1, updated_at: 2, deleted_at: null, images: [], ...over,
});

type Reply = (req: VaultRequest, token: string | null) => unknown;

/**
 * 桩：按 action 回指定的东西（可以是 Promise，测“请求在路上”）；VaultFail 原样回，别的当成功响应按 schema 校验。
 * 和服务器一样（vault-image 的 ownsPrivateNote，M1）：只收已经存在的隐私记的图——save 成功过的 id（加上列表里那一条）才算存在
 */
function fakeApi(replies: Partial<Record<VaultRequest['action'], Reply>>) {
  const calls: { action: string; token: string | null; req: VaultRequest }[] = [];
  const saved = new Set<string>([NID]);
  const api: VaultApi = {
    async call<S extends z.ZodType>(req: VaultRequest, token: string | null, schema: S): Promise<VaultResult<z.infer<S>>> {
      calls.push({ action: req.action, token, req });
      const fn = replies[req.action];
      const v: unknown = await (fn ? fn(req, token) : { ok: true, vault_token: TOK, expires_at: 9e12 });
      if (typeof v === 'object' && v !== null && (v as { ok?: unknown }).ok === false) return v as VaultFail;
      const p = schema.safeParse(v);
      if (p.success && req.action === 'save') saved.add(req.id);
      return p.success ? { ok: true, value: p.data } : { ok: false, code: 'unknown' };
    },
    imageGet: vi.fn(async () => ({ ok: true as const, value: new Blob(['x']) }) as VaultResult<Blob>),
    imageUpload: vi.fn(async (q: { note_id: string }) =>
      saved.has(q.note_id) ? ({ ok: true, value: true } as const) : ({ ok: false, code: 'not_found' } as VaultFail)),
  };
  return { api, calls };
}

export const statusSet = { ok: true, set: true, locked_until: null, last_reset_at: null, webauthn: 0 };
export const tokenOk = { ok: true, vault_token: TOK, expires_at: 9e12 };
export const listOk = (notes: VaultNote[] = [note()]) => ({ ok: true, notes, vault_token: TOK, expires_at: 9e12 });

export function make(replies: Partial<Record<VaultRequest['action'], Reply>> = {}) {
  const { api, calls } = fakeApi({ status: () => statusSet, unlock: () => tokenOk, list: () => listOk(), ...replies });
  const tokens: (string | null)[] = [];
  const revoked: string[] = [];
  let n = 0;
  const clock = { ms: 1_000_000 };
  const s = createVaultSession({
    api,
    now: () => clock.ms,
    onToken: (t) => tokens.push(t),
    createUrl: () => `blob:x/${++n}`,
    revokeUrl: (u) => revoked.push(u),
    newId: () => '33333333-3333-4333-8333-333333333333',
  });
  return { s, api, calls, tokens, revoked, clock };
}

/** 一个手动放行的请求：先挂起，release(v) 时才回 */
export function held() {
  let release!: (v: unknown) => void;
  const p = new Promise<unknown>((r) => (release = r));
  return { p, release: (v: unknown) => release(v) };
}

export async function unlocked(replies: Partial<Record<VaultRequest['action'], Reply>> = {}) {
  const m = make(replies);
  await m.s.refreshStatus();
  expect((await m.s.unlock('1234')).ok).toBe(true);
  return m;
}
