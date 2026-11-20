// shared/core/signal.ts：按订阅顺序叫、带参数、先拍快照（叫的过程中新订的这一轮不叫、退订的这一轮照叫）、同一函数只算一次、
// 退订调几次都没关系、clear 全部退订、size；一个回调抛错时后面的这一轮不叫（和原来手写的 for (const fn of [...set]) fn() 一样）。Node 和 Deno 都跑
import { describe, expect, it } from 'vitest';
import { createSignal } from '../../../shared/core/signal.ts';

describe('createSignal', () => {
  it('按订阅顺序叫，参数原样带过去', () => {
    const s = createSignal<[number, string]>();
    const got: string[] = [];
    s.subscribe((n, t) => got.push(`a${n}${t}`));
    s.subscribe((n, t) => got.push(`b${n}${t}`));
    s.emit(1, 'x');
    expect(got).toEqual(['a1x', 'b1x']);
  });

  it('同一个函数订两次只叫一次；退订以后不再叫，退订调两次没关系', () => {
    const s = createSignal();
    let n = 0;
    const fn = (): void => {
      n += 1;
    };
    const off = s.subscribe(fn);
    s.subscribe(fn);
    expect(s.size).toBe(1);
    s.emit();
    off();
    off();
    s.emit();
    expect(n).toBe(1);
    expect(s.size).toBe(0);
  });

  it('先拍快照：叫的过程中新订的这一轮不叫，被前面退订掉的这一轮照叫', () => {
    const s = createSignal();
    const got: string[] = [];
    let offB: () => void = () => undefined;
    s.subscribe(() => {
      got.push('a');
      offB();
      s.subscribe(() => got.push('c'));
    });
    offB = s.subscribe(() => got.push('b'));
    s.emit();
    expect(got).toEqual(['a', 'b']);
    got.length = 0;
    s.emit();
    expect(got).toEqual(['a', 'c']);
  });

  it('clear 全部退订', () => {
    const s = createSignal();
    let n = 0;
    s.subscribe(() => {
      n += 1;
    });
    s.clear();
    s.emit();
    expect(n).toBe(0);
    expect(s.size).toBe(0);
  });

  it('不兜错：一个回调抛错，后面的这一轮不叫，错误抛给 emit 的调用方', () => {
    const s = createSignal();
    const got: string[] = [];
    s.subscribe(() => {
      throw new Error('x');
    });
    s.subscribe(() => got.push('b'));
    expect(() => s.emit()).toThrow('x');
    expect(got).toEqual([]);
  });

  it('subscribe、emit 拆下来单独传也能用（不靠 this）', () => {
    const s = createSignal();
    const { subscribe, emit } = s;
    let n = 0;
    subscribe(() => {
      n += 1;
    });
    emit();
    expect(n).toBe(1);
  });
});
