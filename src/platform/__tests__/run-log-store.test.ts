// 运行日志分段存（platform/run-log-store.ts；11-20 全 app 改善报告第四节）：写入量下降、复制出来的内容和原来整份一个键时逐字相同、
// 切后台和关闭时最后几行不丢、崩溃（不经停止函数）时 300ms 以前的行都在本机
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHUNK_LINES, chunkKey, clearRunLog, createRunLogWriter, MAX_LINES, OLD_KEY, readRunLog } from '../run-log-store.ts';
import { startRunLog } from '../run-log.ts';
import { rlog, RL_SLOT } from '../run-log-api.ts';

const LINE = 'x'.repeat(100);

/** 数 setItem 次数和字数的存储；oldChars = 原来的写法每次存要写的字数（那一刻整份日志的长度） */
function countingStore() {
  const real = localStorage;
  const n = { calls: 0, chars: 0, max: 0, oldChars: 0 };
  const store = {
    getItem: (k: string) => real.getItem(k),
    setItem: (k: string, v: string) => {
      n.calls += 1;
      n.chars += v.length;
      n.max = Math.max(n.max, v.length);
      real.setItem(k, v);
      n.oldChars += readRunLog(real).length;
    },
    removeItem: (k: string) => real.removeItem(k),
    key: (i: number) => real.key(i),
    get length() {
      return real.length;
    },
    clear: () => real.clear(),
  } as Storage;
  return { store, n };
}

describe('运行日志分段存', () => {
  afterEach(() => {
    localStorage.clear();
    delete (globalThis as Record<string, unknown>)[RL_SLOT];
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('复制出来的 = 记过的所有行的最后 MAX_LINES 行（和原来整份一个键一样）；跨重开接着记也一样', () => {
    const all: string[] = [];
    let w = createRunLogWriter(localStorage);
    for (let i = 0; i < 7777; i += 1) {
      const l = `t=${i} line ${i} ${LINE}`;
      all.push(l);
      w.push(l);
      if (i % 37 === 0) w.save();
      if (i === 4000) {
        w.save();
        w = createRunLogWriter(localStorage); // 冷启动：接着本机已有的记
      }
      if (i % 501 === 0) {
        w.save();
        expect(readRunLog()).toBe(all.slice(-MAX_LINES).join('\n'));
      }
    }
    w.save();
    expect(readRunLog()).toBe(all.slice(-MAX_LINES).join('\n'));
    // 段数有上限：最多 MAX_LINES / CHUNK_LINES + 2 段
    const segs = Object.keys(localStorage).filter((k) => k.startsWith(`${OLD_KEY}.c`));
    expect(segs.length).toBeLessThanOrEqual(MAX_LINES / CHUNK_LINES + 2);
  });

  it('11-20 以前一个键整份存的旧日志：第一次启动读进来、按段写好、删掉旧键，复制出来的不变', () => {
    const old = Array.from({ length: MAX_LINES }, (_, i) => `old${i}`);
    localStorage.setItem(OLD_KEY, old.join('\n'));
    expect(readRunLog()).toBe(old.join('\n')); // 还没迁移时也读得到
    const w = createRunLogWriter(localStorage);
    w.push('new');
    w.save();
    expect(localStorage.getItem(OLD_KEY)).toBeNull();
    expect(readRunLog()).toBe([...old.slice(1), 'new'].join('\n'));
  });

  it('写入量：每次存只写最新一段（一个键）；60 秒每 50ms 一行，字数不到原来整份写的 1/10，次数不多于原来', async () => {
    vi.useFakeTimers();
    // 先有满满一份日志（已是分段格式），再量下一次打开
    const w = createRunLogWriter(localStorage);
    for (let i = 0; i < MAX_LINES; i += 1) w.push(`t=0 old${i} ${LINE}`);
    w.save();
    const { store, n } = countingStore();
    const stop = startRunLog(window, { version: 'm', store });
    let saves = 0;
    for (let i = 0; i < 1200; i += 1) {
      rlog(`work ${i} ${LINE}`);
      const before = n.calls;
      await vi.advanceTimersByTimeAsync(50);
      if (n.calls > before) saves += 1;
    }
    stop();
    // 原来：每次存一次 setItem、写整份（约 35 万字）。现在：每次存也只一次 setItem，写的是最新一段
    expect(n.calls).toBeLessThanOrEqual(saves + 2); // 开头一次、停止一次
    expect(n.max).toBeLessThan(((CHUNK_LINES + 20) * (LINE.length + 30)));
    expect(n.chars * 10).toBeLessThan(n.oldChars);
  });

  it('切到后台、关页面（pagehide）：最后一行当场存进本机，不等 300ms', () => {
    vi.useFakeTimers();
    const stop = startRunLog(window, { version: 'v' });
    vi.advanceTimersByTime(1000);
    rlog('last before hidden');
    const vis = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(readRunLog()).toMatch(/app last before hidden\n.*visibility=hidden/);
    vis.mockRestore();
    rlog('last before pagehide');
    window.dispatchEvent(new Event('pagehide'));
    expect(readRunLog()).toMatch(/app last before pagehide$/);
    stop();
  });

  it('崩溃（不调停止函数、不发 pagehide）：记下以后 300ms 就已经在本机', () => {
    vi.useFakeTimers();
    startRunLog(window, { version: 'v' });
    vi.advanceTimersByTime(1000);
    for (let i = 0; i < 5; i += 1) rlog(`crash-${i}`);
    vi.advanceTimersByTime(300);
    expect(readRunLog().split('\n').slice(-5)).toEqual([0, 1, 2, 3, 4].map((i) => expect.stringMatching(new RegExp(`app crash-${i}$`))));
  });

  it('清空：旧键和各段都删掉', () => {
    localStorage.setItem(OLD_KEY, 'a');
    localStorage.setItem(chunkKey(3), 'b');
    localStorage.setItem('other', 'keep');
    clearRunLog();
    expect(readRunLog()).toBe('');
    expect(localStorage.getItem('other')).toBe('keep');
  });

  it('存不下（满了）：丢最旧的段再存，最新的行留着', () => {
    const w0 = createRunLogWriter(localStorage);
    for (let i = 0; i < 1000; i += 1) {
      w0.push(`a${i}`);
      if (i % CHUNK_LINES === CHUNK_LINES - 1) w0.save(); // 照真的节奏：存过才换段
    }
    const real = localStorage;
    let full = true;
    const store = {
      getItem: (k: string) => real.getItem(k),
      setItem: (k: string, v: string) => {
        // 本机还剩不少段时假装满了
        if (full && Object.keys(real).filter((x) => x.startsWith(`${OLD_KEY}.c`)).length > 2) throw new DOMException('full', 'QuotaExceededError');
        full = false;
        real.setItem(k, v);
      },
      removeItem: (k: string) => real.removeItem(k),
      key: (i: number) => real.key(i),
      get length() {
        return real.length;
      },
      clear: () => real.clear(),
    } as Storage;
    const w = createRunLogWriter(store);
    w.push('newest');
    w.save();
    expect(readRunLog()).toMatch(/newest$/);
  });
});
