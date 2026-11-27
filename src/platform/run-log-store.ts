// 全局运行日志的本机存储（platform/run-log.ts 用；诊断页“Copy run log”“Send run log”经 readRunLog 读）
// 分段存（不整份同步写一个大键，免得卡主线程）：每 CHUNK_LINES 行一段、一段一个键（lemo-run-log.c<序号>）。每次只重写最新那一段，写满的段以后不再写，
// 最旧的整段在剩下的仍够 MAX_LINES 行时删掉。有新行后 300ms 存一次、离开页面当场存。
// 读的时候按序号拼起来、取最后 MAX_LINES 行，和整份一个键读出来的逐字相同（单测 run-log.test.ts 比对）。
// 旧格式存的是一个键 OLD_KEY：第一次启动时整份当成一段写好、删掉旧键。
// e2e 在页面里读日志走 tests/e2e/page-helpers.ts 的 readRunLogInPage（同一套拼法），不直接读键。
// 这个文件在首屏前就下载（diag-boot → run-log），首屏预算紧，写法尽量短

export const MAX_LINES = 3000;
/** 一段至少多少行（存的时候满了才换下一段，所以一段会多出最后 300ms 里记的几行）：每次存只写最新这一段 */
export const CHUNK_LINES = 250;
/** 旧格式整份存在这一个键 */
export const OLD_KEY = 'lemo-run-log';
const CHUNK_PREFIX = `${OLD_KEY}.c`;
export const chunkKey = (seq: number): string => `${CHUNK_PREFIX}${seq}`;

type Chunk = { seq: number; lines: string[] };

/** 读一个键按行拆开；没有、读不了当空 */
function linesOf(store: Storage, k: string): string[] {
  try {
    const v = store.getItem(k);
    return v ? v.split('\n') : [];
  } catch {
    return [];
  }
}

/** 删一个键；删不掉就算了（下次再删） */
function del(store: Storage, k: string): void {
  try {
    store.removeItem(k);
  } catch {
    // 删不掉就算了
  }
}

/** 存储里现有的各段（按序号从小到大）；读不了的、空的跳过 */
function loadChunks(store: Storage): Chunk[] {
  const seqs: number[] = [];
  try {
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      const n = k?.startsWith(CHUNK_PREFIX) ? Number(k.slice(CHUNK_PREFIX.length)) : NaN;
      if (Number.isInteger(n) && n >= 0) seqs.push(n);
    }
  } catch {
    return [];
  }
  return seqs
    .sort((a, b) => a - b)
    .map((seq) => ({ seq, lines: linesOf(store, chunkKey(seq)) }))
    .filter((c) => c.lines.length);
}

export function readRunLog(store: Storage = localStorage): string {
  const lines = [...linesOf(store, OLD_KEY), ...loadChunks(store).flatMap((c) => c.lines)];
  return lines.slice(-MAX_LINES).join('\n');
}

export function clearRunLog(store: Storage = localStorage): void {
  del(store, OLD_KEY);
  for (const c of loadChunks(store)) del(store, chunkKey(c.seq));
}

export interface RunLogWriter {
  push(line: string): void;
  /** 把最新一段写进存储 */
  save(): void;
}

/**
 * 日志写入器：接着存储里已有的往下记。
 * 只在存完以后换新段（roll），所以两次存之间新行只会进最新那一段：每次存只写这一个键（dirty 只管它）
 */
export function createRunLogWriter(store: Storage): RunLogWriter {
  let chunks = loadChunks(store);
  /** 要删的段：读的时候已经不会用到（剩下的够 MAX_LINES 行），存的时候删 */
  const drop: number[] = [];
  const old = linesOf(store, OLD_KEY);
  if (old.length) {
    // 旧格式（一个键整份，只有升级后第一次启动走这里）：整份当成一段，下面当场存好、删旧键
    drop.push(...chunks.map((c) => c.seq));
    chunks = [{ seq: (chunks.at(-1)?.seq ?? -1) + 1, lines: old.slice(-MAX_LINES) }];
  }
  let total = chunks.reduce((n, c) => n + c.lines.length, 0);
  let dirty = old.length > 0;
  const full = (): boolean => (chunks.at(-1)?.lines.length ?? 0) >= CHUNK_LINES;
  let roll = full();

  /** 丢最旧的一整段 */
  const shift = (): number => {
    const c = chunks.shift() as Chunk;
    total -= c.lines.length;
    return c.seq;
  };
  const push = (line: string): void => {
    let tail = chunks.at(-1);
    if (!tail || roll) {
      roll = false;
      tail = { seq: (tail?.seq ?? -1) + 1, lines: [] };
      chunks.push(tail);
    }
    tail.lines.push(line);
    total += 1;
    dirty = true;
    // 剩下的仍够 MAX_LINES 行，才删最旧的一整段（读的时候再截最后 MAX_LINES 行）
    while (chunks.length > 1 && total - (chunks[0] as Chunk).lines.length >= MAX_LINES) drop.push(shift());
  };
  const save = (): void => {
    const tail = chunks.at(-1);
    while (dirty && tail) {
      try {
        store.setItem(chunkKey(tail.seq), tail.lines.join('\n'));
        break;
      } catch {
        // 存不下（满了）：先丢最旧的整段（当场删、腾地方）再试；只剩最新一段还存不下就丢它的一半旧行
        if (chunks[0] !== tail) del(store, chunkKey(shift()));
        else if (tail.lines.length > 1) total -= tail.lines.splice(0, tail.lines.length >> 1).length;
        else break;
      }
    }
    dirty = false;
    for (const seq of drop.splice(0)) del(store, chunkKey(seq));
    roll = full();
  };
  if (old.length) {
    save();
    del(store, OLD_KEY);
  }
  return { push, save };
}
