// 表情驱动（MascotDef.moods，#23 Aldo）：素材里加了直达通道（负责人 11-26 选“改素材加直达通道”）——
// 状态机的数字输入 moods.input 设成 n，任意状态（Any State）就转到 ring 里第 n 个表情（n 从 1 起，0 不指定），
// 转场照原素材一步步换时的那条（moods.ms、同一条缓动），所以这里只管“要哪个表情”，不再一步步走
// • 要哪个表情：提醒在响 > 久不操作 > 刚发生的事件（到了以后停 MOOD_HOLD_MS） > 空闲时每 8～15 秒随机换一个 > 平时的表情
// • 持续状态的表情（on.mail、on.sleep，Aldo 是 Mail、Sleep）只在有这个状态时出现：提醒处理完、睡醒，直达回平时的表情（rest），
//   再接着空闲随机（负责人 11-26：之前 Mail 退回 Upset、Sleep 退回 Idle 是为了绕开沿环走，有了直达不需要）
// • 事件过时不补：睡着时来的 done、del 不记（醒来不补播）；MOOD_EVENT_TTL_MS 内还没轮到的（提醒一直在响）丢掉
// • 空闲随机只在当前表情前后 1～2 个里挑，中间隔着 Mail、Sleep 的不算相邻；舞台暂停（离屏、进二级页）时不排随机，恢复再排
// • 双击（shuffle）：在 random 里随机换一个和现在不同的，不受相邻限制；提醒在响、睡着时不换；换完空闲随机重新计时
// • 输入是一个数，设了就一直在：舞台暂停时状态机不走，恢复后自己转过去；载入好了 kick 再设一次
// • 配置里的名字（rest、on、random）必须都在 ring 里，写错直接抛错（目录一致性单测兜住，不会带到线上）
import type { MoodCue, MoodDef } from '../../shared/schema/mascot.ts';

export const MOOD_HOLD_MS = 3000;
export const MOOD_RANDOM_MS: readonly [number, number] = [8000, 15000];
/** 空闲随机最远换到前后第几个 */
export const MOOD_RANDOM_REACH = 2;
/** 事件这么久还没轮到就不演了 */
export const MOOD_EVENT_TTL_MS = 10_000;

type Flag = Extract<MoodCue, 'mail' | 'sleep'>;
type Timer = ReturnType<typeof setTimeout>;

export interface MoodDeps {
  /** 把直达输入设成 n（ring 序号 + 1） */
  set(n: number): void;
  later(fn: () => void, ms: number): Timer;
  cancel(t: Timer | undefined): void;
  /** 0～1，测试里换成固定序列 */
  random?(): number;
  /** 当前表情变了（运行日志用） */
  onMood?(name: string): void;
}

export interface MoodRing {
  /** 状态机回报的状态名：各层的都可以传，不在环上的忽略 */
  report(names: readonly string[]): void;
  cue(c: Exclude<MoodCue, Flag>): void;
  flag(c: Flag, on: boolean): void;
  /** 载入好了、接回留着的舞台：把要的表情再设一次 */
  kick(): void;
  /** 舞台暂停（false）时不排空闲随机，恢复（true）再排 */
  active(on: boolean): void;
  /** 双击：在 random 里随机换一个和现在不同的（不受相邻限制）；提醒在响、睡着时不换 */
  shuffle(): void;
  readonly now: string | null;
  readonly goal: string;
}

/** 配置里写错的名字：rest、on、random 都要在 ring 里 */
export function moodNameErrors(d: MoodDef): string[] {
  const names = [d.rest, ...Object.values(d.on), ...d.random].filter((s): s is string => s !== undefined);
  return names.filter((s) => !d.ring.includes(s));
}

export function createMoodRing(d: MoodDef, x: MoodDeps): MoodRing {
  const bad = moodNameErrors(d);
  // 配置写错（rest、on、random 里有 ring 上没有的名字）：开发时直接报错。报错文字不带汉字（架构 A20）
  if (bad.length > 0) throw new Error(`moods: not on ring: ${bad.join(', ')}`);
  const n = d.ring.length;
  const rnd = x.random ?? Math.random;
  /** 只给持续状态用的表情 */
  const fenced = new Set([d.on.mail, d.on.sleep].filter((s): s is string => s !== undefined));
  const at = (s: string): number => d.ring.indexOf(s);
  /** 环上 a、b 隔几个：两个方向里中间不隔着 fenced 的、近的那边；都隔着为 null。每个方向最多走 n 步 */
  const apart = (a: number, b: number): number | null => {
    if (a < 0 || b < 0) return null;
    let best: number | null = null;
    for (const dir of [1, -1]) {
      for (let steps = 1, i = (a + dir + n) % n; steps <= n; steps += 1, i = (i + dir + n) % n) {
        if (i === b) {
          if (best === null || steps < best) best = steps;
          break;
        }
        if (fenced.has(d.ring[i] ?? '')) break;
      }
    }
    return best;
  };
  let now: string | null = null;
  let event: string | null = null;
  let roam: string | null = null;
  let sent: string | null = null;
  let live = true;
  const flags = new Set<Flag>();
  let hold: Timer | undefined;
  let expire: Timer | undefined;
  let roamT: Timer | undefined;

  const has = (f: Flag): boolean => flags.has(f) && d.on[f] !== undefined;
  const goal = (): string => {
    for (const f of ['mail', 'sleep'] as const) {
      const m = d.on[f];
      if (has(f) && m) return m;
    }
    return event ?? roam ?? d.rest;
  };
  const busy = (): boolean => has('mail') || has('sleep') || event !== null;
  const push = (): void => {
    const g = goal();
    if (g === sent) return;
    sent = g;
    x.set(at(g) + 1);
  };

  const dropEvent = (): void => {
    x.cancel(hold);
    x.cancel(expire);
    hold = undefined;
    expire = undefined;
    event = null;
  };
  const release = (): void => {
    dropEvent();
    push();
  };
  /** 事件的表情到了才开始停；到了就不再过期 */
  const holdIfThere = (): void => {
    if (event === null || now !== event || hold !== undefined) return;
    x.cancel(expire);
    expire = undefined;
    hold = x.later(release, MOOD_HOLD_MS);
  };

  const scheduleRoam = (): void => {
    x.cancel(roamT);
    roamT = undefined;
    if (!live) return;
    const [lo, hi] = MOOD_RANDOM_MS;
    roamT = x.later(() => {
      if (!busy() && now !== null && !fenced.has(now)) {
        const from = at(now);
        const pool = d.random.filter((s) => {
          const k = s === now ? null : apart(from, at(s));
          return k !== null && k <= MOOD_RANDOM_REACH;
        });
        roam = pool[Math.floor(rnd() * pool.length)] ?? roam;
        push();
      }
      scheduleRoam();
    }, lo + rnd() * (hi - lo));
  };
  scheduleRoam();

  return {
    report(names) {
      let changed = false;
      for (const s of names) {
        if (d.ring.includes(s) && s !== now) {
          now = s;
          changed = true;
        }
      }
      if (!changed) return;
      x.onMood?.(now ?? '');
      holdIfThere();
      push();
    },
    cue(c) {
      const m = d.on[c];
      // 睡着时来的不记：醒来不补播
      if (!m || has('sleep')) return;
      dropEvent();
      event = m;
      roam = null;
      expire = x.later(release, MOOD_EVENT_TTL_MS);
      holdIfThere();
      scheduleRoam();
      push();
    },
    flag(c, v) {
      if (flags.has(c) === v) return;
      if (v) flags.add(c);
      else flags.delete(c);
      roam = null;
      scheduleRoam();
      push();
    },
    kick() {
      sent = null;
      push();
    },
    active(v) {
      if (v === live) return;
      live = v;
      scheduleRoam();
    },
    shuffle() {
      if (has('mail') || has('sleep')) return;
      const cur = goal();
      const pool = d.random.filter((s) => s !== cur && s !== now);
      const pick = pool[Math.floor(rnd() * pool.length)];
      if (pick === undefined) return;
      dropEvent();
      roam = pick;
      // 换完重新计时，免得刚换完就被空闲随机换走
      scheduleRoam();
      push();
    },
    get now() {
      return now;
    },
    get goal() {
      return goal();
    },
  };
}
