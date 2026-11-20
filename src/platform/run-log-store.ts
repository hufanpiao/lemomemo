// 全局运行日志的本机存储（platform/run-log.ts 用；诊断页“Copy run log”“Send run log”经 readRunLog 读）
// 11-20 全 app 改善报告第四节（负责人弹窗选定）：原来每 300ms 把最多 3000 行整份拼成一串、同步写进一个键（约 35 万字，主线程），
// 改成分段存：每 CHUNK_LINES 行一段、一段一个键（lemo-run-log.c<序号>）。每次只重写最新那一段，写满的段以后不再写，
// 最旧的整段在剩下的仍够 MAX_LINES 行时删掉。存的节奏不变（仍是有新行后 300ms 存一次、离开页面当场存），崩溃前留下的行和原来一样多。
// 读的时候按序号拼起来、取最后 MAX_LINES 行，和原来整份一个键读出来的逐字相同（单测 run-log.test.ts 比对）。
// 11-20 以前存的是一个键 OLD_KEY：第一次启动时读进来按段写好、删掉旧键。
// e2e 在页面里读日志走 tests/e2e/page-helpers.ts 的 readRunLogInPage（同一套拼法），不直接读键。

export const MAX_LINES = 3000;
/** 一段至少多少行（存的时候满了才换下一段，所以一段会多出最后 300ms 里记的几行）：每次存只写最新这一段（约 250 × 120 字 ≈ 3 万字，原来整份约 35 万字） */
export const CHUNK_LINES = 250;
/** 11-20 以前整份存在这一个键 */
export const OLD_KEY = 'lemo-run-log';
const CHUNK_PREFIX = `${OLD_KEY}.c`;
export const chunkKey = (seq: number): string => `${CHUNK_PREFIX}${seq}`;

/** 存储里现有的各段序号（从小到大）；读不了当没有 */
function chunkSeqs(store: Storage): number[] {
  const out: number[] = [];
  try {
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      if (k?.startsWith(CHUNK_PREFIX)) {
        const n = Number(k.slice(CHUNK_PREFIX.length));
        if (Number.isInteger(n) && n >= 0) out.push(n);
      }
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => a - b);
}

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

/** 全部行（旧格式没迁移的也读）；读不了的段跳过 */
function loadLines(store: Storage): { chunks: Array<{ seq: number; lines: string[] }>; old: string[] } {
  const chunks = chunkSeqs(store)
    .map((seq) => ({ seq, lines: linesOf(store, chunkKey(seq)) }))
    .filter((c) => c.lines.length);
  return { chunks, old: linesOf(store, OLD_KEY) };
}

export function readRunLog(store: Storage = localStorage): string {
  const { chunks, old } = loadLines(store);
  const lines = [...old, ...chunks.flatMap((c) => c.lines)];
  return (lines.length > MAX_LINES ? lines.slice(-MAX_LINES) : lines).join('\n');
}

export function clearRunLog(store: Storage = localStorage): void {
  for (const k of [OLD_KEY, ...chunkSeqs(store).map(chunkKey)]) del(store, k);
}

export interface RunLogWriter {
  push(line: string): void;
  /** 把改过的段写进存储（只写最新的、没封存的那一两段） */
  save(): void;
}

/** 日志写入器：接着存储里已有的往下记 */
export function createRunLogWriter(store: Storage): RunLogWriter {
  const { chunks, old } = loadLines(store);
  /** 要写的段（序号）、要删的段 */
  const dirty = new Set<number>();
  const drop: number[] = [];
  let total = chunks.reduce((n, c) => n + c.lines.length, 0);
  let migrate = old.length > 0;

  const trim = (): void => {
    // 剩下的仍够 MAX_LINES 行，才删最旧的一整段（读的时候再截最后 MAX_LINES 行，和原来一样）
    while (chunks.length > 1 && total - (chunks[0]?.lines.length ?? 0) >= MAX_LINES) {
      const c = chunks.shift();
      if (!c) break;
      total -= c.lines.length;
      dirty.delete(c.seq);
      drop.push(c.seq);
    }
  };
  /** 最新一段已经写满并且存过：下一行起新的一段。只在存完以后换段，每次存都只写一个键（换段那次不用两段一起写） */
  const full = (): boolean => (chunks.at(-1)?.lines.length ?? 0) >= CHUNK_LINES;
  let roll = full();
  const push = (line: string): void => {
    let tail = chunks.at(-1);
    if (!tail || roll) {
      roll = false;
      tail = { seq: (tail?.seq ?? -1) + 1, lines: [] };
      chunks.push(tail);
    }
    tail.lines.push(line);
    total += 1;
    dirty.add(tail.seq);
    trim();
  };
  // 旧格式（一个键整份）：按段放进来，第一次 save 时写好、删旧键（只有升级后第一次启动走这里）
  for (const l of old.length > MAX_LINES ? old.slice(-MAX_LINES) : old) {
    push(l);
    roll = full();
  }

  const write = (seq: number): boolean => {
    const c = chunks.find((x) => x.seq === seq);
    if (!c) return true;
    try {
      store.setItem(chunkKey(seq), c.lines.join('\n'));
      return true;
    } catch {
      return false;
    }
  };
  const remove = (k: string): void => del(store, k);
  const save = (): void => {
    for (const seq of [...dirty].sort((a, b) => a - b)) {
      // 存不下（满了）：先丢最旧的整段再试，只剩最新一段还存不下就丢它的一半旧行（原来是整份丢一半）
      while (!write(seq)) {
        const head = chunks[0];
        if (!head) break;
        if (chunks.length > 1 && head.seq !== seq) {
          chunks.shift();
          total -= head.lines.length;
          dirty.delete(head.seq);
          remove(chunkKey(head.seq));
          continue;
        }
        if (head.lines.length <= 1) break;
        const cut = Math.floor(head.lines.length / 2);
        head.lines.splice(0, cut);
        total -= cut;
      }
      dirty.delete(seq);
    }
    for (const seq of drop.splice(0)) remove(chunkKey(seq));
    roll = full();
    if (migrate) {
      migrate = false;
      remove(OLD_KEY);
    }
  };
  return { push, save };
}
