// push-dispatch/store.ts 的查询写法（B2 BE-2）：supabase-js 换成记调用的假客户端，核对几条关键查询带了该带的条件——
// 出队走 private.remind_queue_pop、认领是条件更新（pushed_for 为空或不等于 due_at）、resolve 的释放只认原来的 pushed_for、
// 设备写回只在 push_endpoint 还是发送时那一串时才写、每条写都带 user_id。真库上的语义由 rls 30_remind_queue_pop 和真库冒烟兜。
// store.ts 顶上有 `import type … from 'npm:…'`：路径放在变量里动态加载（写法同 push-dispatch-usable.test.ts）
import { describe, expect, it } from 'vitest';

type Call = [string, ...unknown[]];
const STORE_PATH = '../../supabase/functions/push-dispatch/store.ts';
const { makeStore, colsOf } = (await import(/* @vite-ignore */ STORE_PATH)) as { makeStore: (a: unknown) => Record<string, (...a: unknown[]) => Promise<unknown>>; colsOf: (t: string) => string };

/** 链式调用全部记下；await 时回 result */
function fakeAdmin(result: { data: unknown; error: unknown } = { data: [], error: null }) {
  const chains: Call[][] = [];
  const chain = (first: Call) => {
    const calls: Call[] = [first];
    chains.push(calls);
    const p: Record<string, unknown> = new Proxy({}, {
      get(_t, k) {
        if (k === 'then') return (ok: (v: unknown) => void) => ok(result);
        return (...a: unknown[]) => {
          calls.push([String(k), ...a]);
          return p;
        };
      },
    });
    return p;
  };
  const admin = {
    from: (t: string) => chain(['from', t]),
    rpc: (f: string, a: unknown) => chain(['rpc', f, a]),
    schema: (s: string) => ({ from: (t: string) => chain(['from', `${s}.${t}`]), rpc: (f: string, a: unknown) => chain(['rpc', `${s}.${f}`, a]) }),
  };
  return { admin, chains };
}

describe('push-dispatch store.ts', () => {
  it('出队：private.remind_queue_pop(p_limit)', async () => {
    const { admin, chains } = fakeAdmin();
    await makeStore(admin).popQueue?.(500);
    expect(chains[0]).toEqual([['rpc', 'private.remind_queue_pop', { p_limit: 500 }]]);
  });
  it('认领：update pushed_for = due_at，条件 id、user_id、pushed_for 为空或不等于 due_at，回更新到的行', async () => {
    const { admin, chains } = fakeAdmin({ data: [{ id: 'x' }], error: null });
    expect(await makeStore(admin).claim?.('todos', 'x', 'u', 123)).toBe(true);
    expect(chains[0]).toEqual([['from', 'todos'], ['update', { pushed_for: 123 }], ['eq', 'id', 'x'], ['eq', 'user_id', 'u'],
      ['or', 'pushed_for.is.null,pushed_for.neq.123'], ['select', 'id']]);
    const none = fakeAdmin({ data: [], error: null });
    expect(await makeStore(none.admin).claim?.('todos', 'x', 'u', 123)).toBe(false);
  });
  it('resolve 释放：只在 pushed_for 还是原来那个值时清空', async () => {
    const { admin, chains } = fakeAdmin({ data: [{ id: 'x' }], error: null });
    await makeStore(admin).releasePushed?.('events', 'x', 'u', 99);
    expect(chains[0]).toEqual([['from', 'events'], ['update', { pushed_for: null }], ['eq', 'id', 'x'], ['eq', 'user_id', 'u'], ['eq', 'pushed_for', 99], ['select', 'id']]);
  });
  it('代码审查建议 ④：writeRemind 带乐观条件（remind_at 还是旧值；旧值为空用 is null），回是否更新到 1 行；纪念日带 next_date', async () => {
    const a = fakeAdmin({ data: [{ id: 'x' }], error: null });
    expect(await makeStore(a.admin).writeRemind?.('todos', 'x', 'u', { remind_at: 7 }, 5)).toBe(true);
    expect(a.chains[0]).toEqual([['from', 'todos'], ['update', { remind_at: 7 }], ['eq', 'id', 'x'], ['eq', 'user_id', 'u'], ['eq', 'remind_at', 5], ['select', 'id']]);
    const b = fakeAdmin({ data: [], error: null });
    expect(await makeStore(b.admin).writeRemind?.('anniversaries', 'x', 'u', { remind_at: 7, next_date: '2027-01-01' }, null)).toBe(false);
    expect(b.chains[0]).toEqual([['from', 'anniversaries'], ['update', { remind_at: 7, next_date: '2027-01-01' }], ['eq', 'id', 'x'], ['eq', 'user_id', 'u'], ['is', 'remind_at', null], ['select', 'id']]);
  });
  it('代码审查建议 ⑥：tzLoggedSince 查本函数写的 tz_invalid（走 user_id、act、src 索引）', async () => {
    const { admin, chains } = fakeAdmin({ data: [{ user_id: 'u1' }, { user_id: 'u1' }], error: null });
    expect([...((await makeStore(admin).tzLoggedSince?.(['u1', 'u2'], 100)) as Set<string>)]).toEqual(['u1']);
    expect(chains[0]).toEqual([['from', 'logs'], ['select', 'user_id'], ['in', 'user_id', ['u1', 'u2']], ['eq', 'act', 'tz_invalid'], ['eq', 'src', 'push-dispatch'], ['gt', 't', 100], ['limit', 1000]]);
  });
  it('设备写回：删订阅、成功归零、失败累加，都带 id、user_id、push_endpoint 原串的条件', async () => {
    const dev = { id: 'd', user_id: 'u', push_endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: 'p', auth: 'a', push_fail_count: 3 };
    const cases: [unknown, unknown][] = [
      [{ ok: false, fails: 1, drop: true }, { push_endpoint: null, p256dh: null, auth: null }],
      [{ ok: true, fails: 2, drop: false }, { last_push_ok_at: 'T', push_fail_count: 0 }],
      [{ ok: false, fails: 2, drop: false }, { push_fail_count: 5 }],
    ];
    for (const [out, body] of cases) {
      const { admin, chains } = fakeAdmin({ data: null, error: null });
      await makeStore(admin).deviceOutcome?.(dev, out, 'T');
      expect(chains[0]).toEqual([['from', 'devices'], ['update', body], ['eq', 'id', 'd'], ['eq', 'user_id', 'u'], ['eq', 'push_endpoint', dev.push_endpoint]]);
    }
  });
  it('到点、resolve 候选走 private.remind_due / remind_pushed（安全审查必改 1、代码审查 M2），再按 id 读整行：保持 SQL 的顺序，行没了、user_id 对不上的丢掉', async () => {
    const keys = [
      { table_name: 'todos', id: 't2', user_id: 'u' },
      { table_name: 'events', id: 'e1', user_id: 'u' },
      { table_name: 'todos', id: 't1', user_id: 'u' },
      { table_name: 'todos', id: 'tx', user_id: 'u' },
      { table_name: 'todos', id: 'ty', user_id: 'u' },
    ];
    const rowsOf: Record<string, unknown[]> = {
      todos: [{ id: 't1', user_id: 'u' }, { id: 't2', user_id: 'u' }, { id: 'ty', user_id: 'other' }],
      events: [{ id: 'e1', user_id: 'u' }],
    };
    for (const [method, fn] of [['dueRows', 'remind_due'], ['pushedRows', 'remind_pushed']] as const) {
      const chains: Call[][] = [];
      const admin = {
        from: (t: string) => {
          const calls: Call[] = [['from', t]];
          chains.push(calls);
          const p: Record<string, unknown> = new Proxy({}, { get: (_x, k) => (k === 'then' ? (ok: (v: unknown) => void) => ok({ data: rowsOf[t] ?? [], error: null }) : (...a: unknown[]) => { calls.push([String(k), ...a]); return p; }) });
          return p;
        },
        schema: () => ({ rpc: (f: string, a: unknown) => { chains.push([['rpc', f, a]]); return Promise.resolve({ data: keys, error: null }); } }),
      };
      const out = (await makeStore(admin)[method]?.(10, 20, 20, 500)) as { table: string; row: { id: string } }[];
      expect(chains[0]).toEqual([['rpc', fn, { p_lo: 10, p_hi: 20, p_per_user: 20, p_limit: 500 }]]);
      expect(out.map((x) => `${x.table}:${x.row.id}`)).toEqual(['todos:t2', 'events:e1', 'todos:t1']);
      // 只读 SQL 给的 id，没有的表不查
      const reads = chains.slice(1).map((c) => [c[0]?.[1], c.find((x) => x[0] === 'in')?.[2]]);
      expect(reads).toEqual([['events', ['e1']], ['todos', ['t2', 't1', 'tx', 'ty']]]);
    }
  });

  it('代码审查 M1：anniversaries 不读 source（没有这一列），读出的纪念日补 source = page（列名逐个核对 db.types.ts 在 tests/build/push-dispatch-cols.test.ts）', async () => {
    expect(colsOf('anniversaries').split(', ')).not.toContain('source');
    const { admin } = fakeAdmin({ data: [{ id: 'a', user_id: 'u' }], error: null });
    expect(await makeStore(admin).rows?.('anniversaries', ['a'])).toEqual([{ id: 'a', user_id: 'u', source: 'page' }]);
  });
  it('代码审查 M5：.in(...) 每批最多 100 个 id——250 个 id 发 3 次请求（100、100、50），结果合并；重复 id 先去重，空列表不发请求', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`);
    for (const method of ['rows', 'profiles', 'settings', 'devices', 'tzLoggedSince'] as const) {
      const { admin, chains } = fakeAdmin({ data: [{ id: 'x', user_id: 'u', key: 'k', current_tz: 'Asia/Seoul', ui_locale: 'zh' }], error: null });
      const s = makeStore(admin);
      const out = method === 'rows' ? await s.rows?.('todos', [...ids, ids[0]]) : method === 'tzLoggedSince' ? await s.tzLoggedSince?.([...ids, ids[0]], 1) : await s[method]?.([...ids, ids[0]]);
      const sizes = chains.map((c) => (c.find((x) => x[0] === 'in' && (x[1] === 'id' || x[1] === 'user_id'))?.[2] as string[]).length);
      expect(sizes, method).toEqual([100, 100, 50]);
      expect(chains.flatMap((c) => c.find((x) => x[0] === 'in' && (x[1] === 'id' || x[1] === 'user_id'))?.[2] as string[]), method).toEqual(ids);
      if (method === 'rows' || method === 'devices') expect((out as unknown[]).length, method).toBe(3);
      const none = fakeAdmin();
      await (method === 'rows' ? makeStore(none.admin).rows?.('todos', []) : makeStore(none.admin)[method]?.([], 1));
      expect(none.chains, method).toEqual([]);
    }
  });
  it('出错一律抛（不把数据库报错原文往外带）', async () => {
    const { admin } = fakeAdmin({ data: null, error: { message: 'secret detail' } });
    await expect(makeStore(admin).popQueue?.(1)).rejects.toThrow(/^db$/);
  });
});

describe('store.ts 的 inChunks（代码审查 M5 的分批函数；复审建议：独立单测）', () => {
  type InChunks = <T>(ids: readonly string[], run: (chunk: string[]) => Promise<T[]>) => Promise<T[]>;
  const load = async () => (await import(/* @vite-ignore */ STORE_PATH)) as { inChunks: InChunks; IN_CHUNK: number };
  const ids = (n: number, p = 'u') => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const spy = () => {
    const calls: string[][] = [];
    return { calls, run: async (c: string[]) => { calls.push(c); return c.map((x) => `r:${x}`); } };
  };

  it('一批 100 个', async () => {
    expect((await load()).IN_CHUNK).toBe(100);
  });
  it('空列表：不调 run，回 []', async () => {
    const { inChunks } = await load();
    const s = spy();
    expect(await inChunks([], s.run)).toEqual([]);
    expect(s.calls).toEqual([]);
  });
  it('边界：100 个一批；101 个两批（100、1）；结果按批次顺序合并', async () => {
    const { inChunks } = await load();
    const a = spy();
    expect(await inChunks(ids(100), a.run)).toEqual(ids(100).map((x) => `r:${x}`));
    expect(a.calls.map((c) => c.length)).toEqual([100]);
    const b = spy();
    expect(await inChunks(ids(101), b.run)).toEqual(ids(101).map((x) => `r:${x}`));
    expect(b.calls.map((c) => c.length)).toEqual([100, 1]);
    expect(b.calls[1]).toEqual(['u100']);
  });
  it('去重：重复的 id 只发一次，保留第一次出现的位置；去重后正好 100 个就是一批', async () => {
    const { inChunks } = await load();
    const s = spy();
    const input = [...ids(100), 'u5', 'u0', 'u99'];
    expect(await inChunks(input, s.run)).toEqual(ids(100).map((x) => `r:${x}`));
    expect(s.calls).toEqual([ids(100)]);
    const t = spy();
    await inChunks(['b', 'a', 'b', 'c', 'a'], t.run);
    expect(t.calls).toEqual([['b', 'a', 'c']]);
  });
  it('顺序：批与批按顺序发，前一批没回来不发下一批；某一批抛错就整体抛、后面的批不发', async () => {
    const { inChunks } = await load();
    const log: string[] = [];
    let open = 0;
    const run = async (c: string[]) => {
      open++;
      log.push(`start:${c[0]}:${open}`);
      await new Promise((r) => setTimeout(r, 1));
      open--;
      return [c[0]];
    };
    expect(await inChunks(ids(250), run)).toEqual(['u0', 'u100', 'u200']);
    expect(log).toEqual(['start:u0:1', 'start:u100:1', 'start:u200:1']);
    const seen: string[] = [];
    await expect(inChunks(ids(250), async (c) => {
      seen.push(c[0] as string);
      if (c[0] === 'u100') throw new Error('db');
      return [];
    })).rejects.toThrow('db');
    expect(seen).toEqual(['u0', 'u100']);
  });
});
