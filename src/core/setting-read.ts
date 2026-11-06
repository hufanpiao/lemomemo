// settings 一行一键的读（从 setting-write.ts 拆出来，首屏瘦身 H1 第三轮）：只读的这几行不带写设置那一套（setting-patch、write），
// 今天页首屏算提醒列表只要读。setting-write.ts 原样转出这里的导出，别处照旧从 setting-write 引。纯 TS，不准 React（A1）
export interface SettingRow {
  readonly id: string;
  readonly key?: unknown;
  readonly value?: unknown;
  readonly deleted_at?: unknown;
  readonly undone?: unknown;
}

export const live = (r: SettingRow): boolean => (r.deleted_at === null || r.deleted_at === undefined) && r.undone !== true;

/** 这个键现在生效的值；没有、被删、被撤销都是 undefined */
export function settingValue(rows: readonly SettingRow[], key: string): unknown {
  return rows.find((r) => r.key === key && live(r))?.value;
}
