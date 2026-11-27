// 周视图时间轴（按当周事项自动伸缩）：纯 TS
// • 默认 8～22 点；这一周有更早开始的事，起点扩到那个整点（向下取整）；有更晚结束的事，终点扩到那个整点（向上取整）
//   跨午夜切开的段照常算（23:30–24:00 那段让终点到 24）；待办的截止时刻也算（空心圆要画得下）
// • 刻度：每 2 小时一条，从起点本身起（起点是奇数也从它起，如 7、9、11…），终点也标
// • 手机：buildWeek 按 0:00～24:00 = dayPx 排；只显示 [h0, h1] 时把 dayPx 放大成 轨道宽 × 24 / (h1 − h0)，再整体左移 h0 那段

export const AXIS_START = 8;
export const AXIS_END = 22;

export interface HourRange {
  /** 起点整点（0～23） */
  readonly h0: number;
  /** 终点整点（h0 + 1 ～ 24） */
  readonly h1: number;
}

/** 这一周所有事项的 [开始分钟, 结束分钟]（当天第几分钟，结束可以是 1440）→ 显示范围 */
export function weekHourRange(spans: Iterable<readonly [number, number]>): HourRange {
  let h0 = AXIS_START;
  let h1 = AXIS_END;
  for (const [s, e] of spans) {
    if (Number.isFinite(s)) h0 = Math.min(h0, Math.max(0, Math.floor(s / 60)));
    if (Number.isFinite(e)) h1 = Math.max(h1, Math.min(24, Math.ceil(e / 60)));
  }
  return { h0, h1: Math.max(h1, h0 + 1) };
}

/** 刻度整点：从 h0 本身起（单数也从它起：轴扩到 7 点时第一个数字要是 7），每 2 小时一条，加上终点 */
export function axisTicks(r: HourRange): number[] {
  const out: number[] = [];
  for (let h = r.h0; h <= r.h1; h += 2) out.push(h);
  if (out[out.length - 1] !== r.h1) out.push(r.h1);
  return out;
}

/** 某分钟在轨道上的位置（0～1，超出范围的夹到两端） */
export function axisFrac(min: number, r: HourRange): number {
  const f = (min - r.h0 * 60) / ((r.h1 - r.h0) * 60);
  return Math.min(1, Math.max(0, f));
}

/** 此刻（当天第几分钟）在不在显示范围里（含两端）：手机泳道、电脑时间格的“现在”线画不画 */
export function inRange(min: number, r: HourRange): boolean {
  return min >= r.h0 * 60 && min <= r.h1 * 60;
}

/** 手机：轨道实际宽 trackPx 显示 [h0, h1] 时交给 buildWeek 的 dayPx（整天的宽度）和要左移的像素 */
export function phoneScale(trackPx: number, r: HourRange): { dayPx: number; shiftPx: number } {
  const dayPx = (trackPx * 24) / (r.h1 - r.h0);
  return { dayPx, shiftPx: (dayPx * r.h0) / 24 };
}
