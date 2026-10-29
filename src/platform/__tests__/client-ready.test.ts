// supabase/client.ts 的 onClientReady（K6-signedout 审查 M1；复查建议 ③）：
// • 回调在 createClient 之后、getSupabase() 的 Promise 交给任何调用方之前同步调完（会话层在这里挂 onAuthStateChange，比任何 await 都早）
// • 客户端已经建好时当场回调；取消只取消还没回调的
// • 一个回调抛错不挡别的回调，也不挡 getSupabase() 返回客户端
// 每条用例重新载入模块（单例状态不串）；supabase-js 换成假的 createClient，不联网
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createClient = vi.hoisted(() => vi.fn(() => ({ fake: Symbol('db') })));
vi.mock('@supabase/supabase-js', () => ({ createClient }));

import type * as ClientMod from '../supabase/client.ts';

type ClientModule = typeof ClientMod;

async function load(): Promise<ClientModule> {
  vi.resetModules();
  const env = (await import('../env.ts')).buildInfo as { supabaseUrl: string; anonKey: string };
  env.supabaseUrl = 'https://lemotest.supabase.co';
  env.anonKey = 'anon-test';
  return import('../supabase/client.ts');
}

beforeEach(() => {
  createClient.mockClear();
});
afterEach(() => {
  vi.resetModules();
});

describe('onClientReady（复查建议 ③）', () => {
  it('回调在 getSupabase() 交出客户端之前同步调完，拿到的是同一个客户端；只建一次', async () => {
    const c = await load();
    const order: string[] = [];
    let seen: unknown = null;
    c.onClientReady((db) => {
      order.push('ready');
      seen = db;
    });
    const p1 = c.getSupabase().then((db) => {
      order.push('caller-1');
      return db;
    });
    const p2 = c.getSupabase().then(() => void order.push('caller-2'));
    const db = await p1;
    await p2;
    expect(order).toEqual(['ready', 'caller-1', 'caller-2']);
    expect(seen).toBe(db);
    expect(createClient).toHaveBeenCalledTimes(1);
  });

  it('客户端已经建好：当场回调（同步），返回的取消函数什么也不做', async () => {
    const c = await load();
    const db = await c.getSupabase();
    const fn = vi.fn();
    const off = c.onClientReady(fn);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(db);
    expect(() => off()).not.toThrow();
  });

  it('建好之前取消：不再回调；没取消的照常回调', async () => {
    const c = await load();
    const a = vi.fn();
    const b = vi.fn();
    const offA = c.onClientReady(a);
    c.onClientReady(b);
    offA();
    await c.getSupabase();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('一个回调抛错：不挡后面的回调，getSupabase() 照样拿到客户端', async () => {
    const c = await load();
    const later = vi.fn();
    c.onClientReady(() => {
      throw new Error('boom');
    });
    c.onClientReady(later);
    const db = await c.getSupabase();
    expect(later).toHaveBeenCalledWith(db);
  });

  it('不触发加载：只挂回调时不建客户端（加载仍由 getSupabase 决定）', async () => {
    const c = await load();
    c.onClientReady(vi.fn());
    await Promise.resolve();
    expect(createClient).not.toHaveBeenCalled();
  });
});
