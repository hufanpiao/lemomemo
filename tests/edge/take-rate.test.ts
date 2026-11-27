// 后端安全审查第 7 条：private.take_rate 的调用只留 _shared/take-rate.ts 的 rpcTakeRate 一份。
// ① rpcTakeRate：回的不是布尔、出错一律抛（不当放行，也不当拒绝）；给了 signal 就挂 .abortSignal(signal)（store-timeout 超时能中止）；
// ② 服务器函数里除了它，不再有别处直接 rpc('take_rate', …)（ai-*、note-search 和 _shared/ai 另一条线在改，这次不收）。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { rpcTakeRate, type TakeRateClient } from '../../supabase/functions/_shared/take-rate.ts';

const FN = join(import.meta.dirname, '..', '..', 'supabase', 'functions');

/** 假 admin：rpc 回一个可 await 的构造器，记下调用参数和挂上的 signal */
function fakeAdmin(result: { data: unknown; error: unknown }) {
  const seen: { fn?: string; args?: unknown; signal?: AbortSignal } = {};
  const builder = {
    abortSignal(s: AbortSignal) { seen.signal = s; return builder; },
    then<T>(ok: (v: { data: unknown; error: unknown }) => T) { return Promise.resolve(result).then(ok); },
  };
  const admin = { schema: (s: string) => { expect(s).toBe('private'); return { rpc: (fn: string, args: unknown) => { seen.fn = fn; seen.args = args; return builder; } }; } };
  return { admin: admin as unknown as TakeRateClient, seen };
}

describe('rpcTakeRate（_shared/take-rate.ts）', () => {
  it('true / false 原样回；参数按 p_key、p_limit、p_window_s 传', async () => {
    for (const v of [true, false]) {
      const { admin, seen } = fakeAdmin({ data: v, error: null });
      expect(await rpcTakeRate(admin)('k:1', 5, 60)).toBe(v);
      expect([seen.fn, seen.args, seen.signal]).toEqual(['take_rate', { p_key: 'k:1', p_limit: 5, p_window_s: 60 }, undefined]);
    }
  });
  it('回的不是布尔、出错：一律抛', async () => {
    for (const r of [{ data: null, error: null }, { data: 'true', error: null }, { data: 1, error: null }, { data: true, error: { message: 'x' } }]) {
      await expect(rpcTakeRate(fakeAdmin(r).admin)('k', 1, 1)).rejects.toThrow('db');
    }
  });
  it('给了 signal：挂到这一次调用上', async () => {
    const { admin, seen } = fakeAdmin({ data: true, error: null });
    const ac = new AbortController();
    await rpcTakeRate(admin, ac.signal)('k', 1, 1);
    expect(seen.signal).toBe(ac.signal);
  });
});

describe('服务器函数不再各写一份 take_rate 调用', () => {
  const skip = (d: string) => d === '_shared' || d === 'gen' || d.startsWith('ai-') || d === 'note-search' || d.startsWith('_');
  it('除 _shared/take-rate.ts（和另一条线在改的 ai-*、note-search、_shared/ai）外没有 rpc(\'take_rate\'', () => {
    const hits: string[] = [];
    for (const d of readdirSync(FN)) {
      const dir = join(FN, d);
      if (!statSync(dir).isDirectory() || skip(d)) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.ts') && /rpc\(\s*'take_rate'/.test(readFileSync(join(dir, f), 'utf8'))) hits.push(`${d}/${f}`);
      }
    }
    expect(hits).toEqual([]);
  });
});
