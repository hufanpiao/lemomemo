// 离线队列项的格式版本和迁移（架构 4.2、0.27 第 1 点）
// • 队列项带 v（格式版本，从 1 开始）和 app（入队时的 App 版本）
// • 新版启动时先把低版本的项逐级改成当前格式再发；比自己高的 v 留着不发（旧版回退时不弄坏新版的项）
// • 改了 OutboxItem 的形状：OUTBOX_V 加 1，在 outboxMigrations 末尾加 {to: 新版本, up(old) {…}}
// 纯 TS：不准 import React 和任何功能（A1）

/** 当前队列项格式版本 */
export const OUTBOX_V = 1;

/** 一步迁移：把 v = to - 1 的项改成 v = to（up 返回新对象，不用改 v，外面会写） */
export interface OutboxMigration {
  readonly to: number;
  up(item: Readonly<Record<string, unknown>>): Record<string, unknown>;
}

/** 迁移表。v = 1 是第一版，还没有迁移 */
export const outboxMigrations: readonly OutboxMigration[] = [];

export type OutboxMigrateResult =
  /** 已经是当前格式，或者迁移成功 */
  | { kind: 'ok'; item: Record<string, unknown>; changed: boolean }
  /** 比当前版本高：留着不发、不改 */
  | { kind: 'future' }
  /** 迁移失败或格式坏了：留着不发、不删（还是用户的内容），记日志 */
  | { kind: 'stuck'; error: string };

/** 把一项逐级改到 currentV；没有 v 的当作 1（第一版） */
export function migrateOutboxItem(
  raw: Readonly<Record<string, unknown>>,
  migrations: readonly OutboxMigration[] = outboxMigrations,
  currentV: number = OUTBOX_V,
): OutboxMigrateResult {
  const v0 = raw['v'] === undefined ? 1 : raw['v'];
  if (typeof v0 !== 'number' || !Number.isInteger(v0) || v0 < 1) return { kind: 'stuck', error: 'outbox_bad_v' };
  if (v0 > currentV) return { kind: 'future' };
  let item: Record<string, unknown> = { ...raw, v: v0 };
  for (let v = v0 + 1; v <= currentV; v++) {
    const m = migrations.find((x) => x.to === v);
    if (!m) return { kind: 'stuck', error: `outbox_migration_missing:${v}` };
    try {
      item = { ...m.up(item), v };
    } catch (e) {
      return { kind: 'stuck', error: e instanceof Error ? e.name : 'error' };
    }
  }
  return { kind: 'ok', item, changed: v0 !== currentV || raw['v'] === undefined };
}
