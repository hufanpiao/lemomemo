// 前 3 次打开 App 时“＋”上方常驻的小气泡“按住说话 · 点一下打字”（B3 任务单 S23、架构审 M7；定稿线框“第一次使用”：
// “前 3 次打开时，‘＋’上方常驻一个小气泡……按住过一次后就不再出现”）
// • 次数记 prefs（任务单 S23 原文）：v4 的 prefs 落在本机库的 drafts 仓，同打字条草稿（type-draft.ts）、AI 剩余次数（quota.ts）；
//   按账号分，退出、换账号随整库清掉。id 固定 'capture:hint'，data {opens, held}
// • 每启动一次 App 只算一次（模块级标记）；按住过一次（FA-3 录音那边调 markPlusHeld）就再也不出现，当场就收起（不等下次打开）
// • 本机库还没准备好（例如还在登录页）：返回 null、不记这次结果，调用方下次再查（S23 代码审建议 3）
// • 读写失败（库正在关）同上：返回 null、不记结果，调用方下次再查（S23 复审 R1），不抛错
// 纯 TS：不准 import React（A1）
import type { Cache } from '../../../core/cache.ts';
import { getBoot } from '../../../core/boot.ts';

/** 开关：按住说话要到 FA-3 才有，之前关着（主持人 11-09 定）；FA-3 接上录音（ui/RecordHost.tsx），打开 */
export const PLUS_HINT_ENABLED: boolean = true;

export const PLUS_HINT_ID = 'capture:hint';
/** 前几次打开显示 */
export const PLUS_HINT_OPENS = 3;

type DraftStore = Pick<Cache, 'getDraft' | 'putDraft'>;
const cacheOf = (c?: DraftStore | null): DraftStore | null => (c === undefined ? (getBoot()?.cache ?? null) : c);

interface HintData {
  opens: number;
  held: boolean;
}

function dataOf(v: unknown): HintData {
  const x = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const opens = typeof x['opens'] === 'number' && Number.isInteger(x['opens']) && x['opens'] >= 0 ? x['opens'] : 0;
  return { opens, held: x['held'] === true };
}

let counted: Promise<boolean | null> | null = null;
/** 这次启动里按住过（markPlusHeld 一调就是 true）：气泡当场收起 */
let heldNow = false;
const heldWatchers = new Set<() => void>();

/** 这次启动要不要出气泡；第一次查成功时把打开次数 +1（同一次启动再调返回同一个结果）。
 *  本机库还没准备好、读写出错时都返回 null、不记结果，调用方下次再查 */
export function plusHintThisLaunch(now: number, c?: DraftStore | null): Promise<boolean | null> {
  if (heldNow) return Promise.resolve(false);
  if (counted) return counted;
  const cache = cacheOf(c);
  if (!cache) return Promise.resolve(null);
  let failed = false;
  const p = (async (): Promise<boolean | null> => {
    try {
      const d = dataOf((await cache.getDraft(PLUS_HINT_ID))?.data);
      if (d.held || d.opens >= PLUS_HINT_OPENS) return false;
      await cache.putDraft({ id: PLUS_HINT_ID, kind: 'hint', data: { opens: d.opens + 1, held: false }, updated_at: now });
      return true;
    } catch {
      failed = true;
      return null;
    }
  })();
  counted = p;
  // 出错的这次不记：清掉，下次再查
  void p.then(() => {
    if (failed && counted === p) counted = null;
  });
  return p;
}

/** 这次启动里按住过没有（给 usePlusHint 订阅） */
export function plusHeldNow(): boolean {
  return heldNow;
}

/** 按住过一次时通知（usePlusHint 收起气泡）；返回退订 */
export function watchPlusHeld(fn: () => void): () => void {
  heldWatchers.add(fn);
  return () => {
    heldWatchers.delete(fn);
  };
}

/** 按住“＋”说过一次话（FA-3 调）：气泡当场收起，以后也不再出 */
export async function markPlusHeld(now: number, c?: DraftStore | null): Promise<void> {
  if (!heldNow) {
    heldNow = true;
    for (const fn of [...heldWatchers]) fn();
  }
  const cache = cacheOf(c);
  if (!cache) return;
  try {
    const d = dataOf((await cache.getDraft(PLUS_HINT_ID))?.data);
    if (d.held) return;
    await cache.putDraft({ id: PLUS_HINT_ID, kind: 'hint', data: { opens: d.opens, held: true }, updated_at: now });
  } catch {
    // 库没开、正在关：这次不记
  }
}

/** 只给单测用 */
export function resetPlusHintForTest(): void {
  counted = null;
  heldNow = false;
  heldWatchers.clear();
}
