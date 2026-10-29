// 日志队列的本机存放（架构 0.38 第 68 条）：localStorage 的 lemo.logq.<user_id>；读写失败不抛；退出、换账号时清
import { describe, expect, it } from 'vitest';
import { clearLogQueue, clearOtherLogQueues, logQueueKey, logQueueStore } from '../log-store.ts';

function mem(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
  };
}

const fail = (): never => {
  throw new Error('SecurityError');
};
const broken = (): Storage =>
  ({
    get length(): number {
      return fail();
    },
    key: fail,
    getItem: fail,
    setItem: fail,
    removeItem: fail,
    clear: () => undefined,
  }) as Storage;

describe('logQueueStore', () => {
  it('一个账号一个键：lemo.logq.<user_id>', () => {
    const s = mem();
    const a = logQueueStore('A', s);
    expect(a.read()).toBeNull();
    expect(a.write('[1]')).toBe(true);
    expect(s.getItem('lemo.logq.A')).toBe('[1]');
    expect(logQueueStore('B', s).read()).toBeNull();
    expect(logQueueKey('A')).toBe('lemo.logq.A');
  });

  it('读写抛错：读回 undefined、写回 false，不抛', () => {
    const b = logQueueStore('A', broken());
    expect(b.read()).toBeUndefined();
    expect(b.write('x')).toBe(false);
  });
});

describe('清队列', () => {
  it('clearLogQueue(userId)：只清这个账号的，别的键不动', () => {
    const s = mem();
    s.setItem('lemo.logq.A', '1');
    s.setItem('lemo.logq.B', '2');
    s.setItem('lemo.install_id', 'i');
    clearLogQueue('A', s);
    expect(s.getItem('lemo.logq.A')).toBeNull();
    expect(s.getItem('lemo.logq.B')).toBe('2');
    expect(s.getItem('lemo.install_id')).toBe('i');
  });

  it('clearLogQueue(null)（读不到是谁）：清全部 lemo.logq.*，别的键不动', () => {
    const s = mem();
    s.setItem('lemo.logq.A', '1');
    s.setItem('lemo.logq.B', '2');
    s.setItem('pv-locale', 'ko');
    clearLogQueue(null, s);
    expect(s.length).toBe(1);
    expect(s.getItem('pv-locale')).toBe('ko');
  });

  it('clearOtherLogQueues：换账号时清掉别的账号留下的，保留自己的', () => {
    const s = mem();
    s.setItem('lemo.logq.A', '1');
    s.setItem('lemo.logq.B', '2');
    s.setItem('lemo.install_id', 'i');
    clearOtherLogQueues('B', s);
    expect(s.getItem('lemo.logq.A')).toBeNull();
    expect(s.getItem('lemo.logq.B')).toBe('2');
    expect(s.getItem('lemo.install_id')).toBe('i');
  });

  it('存储不可用：都不抛', () => {
    expect(() => clearLogQueue('A', broken())).not.toThrow();
    expect(() => clearLogQueue(null, broken())).not.toThrow();
    expect(() => clearOtherLogQueues('A', broken())).not.toThrow();
  });
});
