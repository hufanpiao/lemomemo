// 后端安全审查第 10 条：account-purge 的调用计数（预算按调用次数）对 store 不再逐个方法手工包一层，
// 改成 countCalls 通用包装：对象上的每个方法（含原型上的、以后新加的）调一次记一次，属性原样透出，this 仍是原对象。
import { describe, expect, it } from 'vitest';
import { countCalls, type Ops } from '../../supabase/functions/account-purge/core.ts';

class Store {
  seen: string[] = [];
  readonly limit = 3;
  async listDue() { this.seen.push('listDue'); return []; }
  async newMethod(x: number) { this.seen.push(`new:${x}`); return x * 2; }
}

describe('countCalls（account-purge/core.ts）', () => {
  it('每个方法一次计一次，包括清单里没列过的新方法；this 是原对象；非函数属性原样', async () => {
    const ops: Ops = { n: 0 };
    const raw = new Store();
    const s = countCalls(raw, ops);
    await s.listDue();
    expect(await s.newMethod(21)).toBe(42);
    await s.newMethod(1);
    expect([ops.n, raw.seen, s.limit]).toEqual([3, ['listDue', 'new:21', 'new:1'], 3]);
  });
  it('两段各一份 ops，互不挤占', async () => {
    const a: Ops = { n: 0 };
    const b: Ops = { n: 0 };
    const raw = new Store();
    await countCalls(raw, a).listDue();
    await countCalls(raw, b).listDue();
    await countCalls(raw, b).listDue();
    expect([a.n, b.n]).toEqual([1, 2]);
  });
});
