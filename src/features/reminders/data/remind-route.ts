// 整页提醒的地址（架构 5.3“整页提醒地址”、B2 安全审查 FE-3）：页面一侧自己再校验 kind、id、due
// 地址 = /app/#/remind/<kind>/<id>?due=<dueAt>，hash 必须整串匹配 ^#/remind/(event|todo|anniv)/<uuid>\?due=[1-9][0-9]*$；
// 不认 next、redirect、url 这类参数（多带任何东西都不匹配），due 必须是正的安全整数
import type { ReminderKind } from '../../../../shared/logic/remind-route.ts';

export interface ReminderRef {
  readonly kind: ReminderKind;
  readonly id: string;
  readonly dueAt: number;
}

const HASH_RE = /^#\/remind\/(event|todo|anniv)\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\?due=([1-9][0-9]*)$/;

/** location.hash → 哪一条哪一次；不合格返回 null（页面显示“这条提醒找不到了”，不跳到别处） */
export function parseReminderHash(hash: string): ReminderRef | null {
  const m = HASH_RE.exec(hash);
  if (!m) return null;
  const dueAt = Number(m[3]);
  if (!Number.isSafeInteger(dueAt)) return null;
  return { kind: m[1] as ReminderKind, id: m[2] as string, dueAt };
}
