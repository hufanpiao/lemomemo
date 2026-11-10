// settings 里的两个 AI 开关 ai.enabled、ai.vault 的唯一写法（架构 15.5、0.41 第 2 条、0.29 续第 146 条）
// • 只写 value：关掉就是 value = false，永远不发软删（deleted_at）、不发撤销（undone）；write.* 里另有守门，发了也入不了队；
//   源码一侧由 ESLint lemo/settings-ai-write（架构 2.3 A31）拦：别处不准对 settings 写 deleted_at / undone、不准用 write.* 写这两个键
// • ai.vault 只能写 false（打开只能经服务器 set_ai_vault，要 vault_token），类型上就写不出 true
// • 本机集合里已有这一行：patch value；那一行被软删或撤销过（服务器以前留下的）就顺带恢复（deleted_at 改回 null、undone 改回 false，
//   恢复不被 settings_guard 拦，0.41 第 1 条）；本机没有这一行：insert 一行新的（id 本机生成）
// • 值已经一样、也没被删：不写，返回 { ok: true, item: null }
// • 本机还没拉到服务器上已有的那一行时 insert 会和 (user_id, key) 唯一约束撞上（CONSENT-sugg ②）：首次告知页（consent_policy_ver 为空）时
//   服务器上一般没有 ai.enabled 行（只有 record_consent 的撤回分支写它，写了就有版本号），以后从设置页重开告知页时才可能碰到。
//   writeAiSwitchSettled 兜这一种：insert 那一项被服务器拒（outbox 的 error / rejected 事件）以后，等同步把服务器那一行拉进集合，
//   再按那一行 patch 一次；SETTLE_MS 内没等到就算了（AI 只是还没打开，设置 › 语音与 AI 能再开）。
//   被拒（error 事件）时先把那一项连同本机那一行删掉（outbox.discardUnlessInflight），再等服务器那一行补 patch（R-378，主持人 11-10 定）：
//   R-378 起新建失败的 insert 默认留在本机、标“未同步”，这一种留着只会再撞一次约束，按原来“回滚再补”处理；例外放在这里，不进 outbox 的首屏代码。
//   正在发的（inflight，用户刚点了重试）不动，“是不是在发”和“删”在同一个写事务里判断（K6-sugg4 ③）；rejected（已丢掉）的本来就不在队列里。
//   SETTLE_MS 到点只停“等服务器那一行”，error / rejected 的监听留到它们来了才摘（代码审查必改 1）：到点以后才被拒的照样回滚，
//   不然它留在本机标“未同步”，另存又换不了 (user_id,key)。发成功的那一项没有事件，监听留到页面关（一个闭包，只在首次打开 AI 开关时有）。
//   已知：error 事件在 outbox 刷新状态之后才发，删掉之前那一瞬间这条记录在 remindRecs 里，“未同步”提示条可能闪一下
// • 被拒时服务器实际回的（K6-sugg3 ② 核对）：insert 不走 apply_patch，走 PostgREST 的 upsert(onConflict: 'id', ignoreDuplicates)
//   （platform/supabase/sync-transport.ts 的 insertRow，= INSERT … ON CONFLICT (id) DO NOTHING）；撞的是 (user_id, key) 不是 id，
//   ON CONFLICT 兜不住，抛 unique_violation（SQLSTATE 23505），PostgREST 回 HTTP 409、code '23505'；toFailure 得 {status: 409, code: '23505'}，
//   classifyFailure 归 permanent → outbox 发 error 事件、这一项进“发送失败”区。apply_patch 自己只把 applied_ops 主键冲突当幂等处理，
//   别的唯一约束照原样抛（同样是 409 / 23505），settings 的 patch 改不了 key，碰不到 (user_id, key)
// 纯 TS：不准 import React 和任何功能（A1）
import { getBoot } from './boot.ts';
import { collection, type Row } from './store.ts';
import { settingPatch } from './setting-patch.ts';
import { write, type WriteResult } from './write.ts';

export type AiSwitch = { key: 'ai.enabled'; value: boolean } | { key: 'ai.vault'; value: false };

interface SettingsRow extends Row {
  key?: unknown;
  value?: unknown;
  deleted_at?: unknown;
  undone?: unknown;
}

const settings = () => collection<SettingsRow>('settings');

/** 本机集合里这个键的那一行（skipId：不算这一行，等服务器那一行时用） */
function rowOf(key: string, skipId?: string): SettingsRow | undefined {
  return settings()
    .getSnapshot()
    .find((r) => r.key === key && r.id !== skipId);
}

export function writeAiSwitch(sw: AiSwitch, newId: () => string = () => crypto.randomUUID()): Promise<WriteResult> {
  return writeOn(sw, rowOf(sw.key), newId);
}

/** 按给定的那一行写（没有就 insert） */
async function writeOn(sw: AiSwitch, row: SettingsRow | undefined, newId: () => string): Promise<WriteResult> {
  if (!row) return write.insert('settings', { id: newId(), key: sw.key, value: sw.value });
  const data = settingPatch(row, sw.value);
  if (!data) return { ok: true, item: null };
  return write.patch('settings', row.id, data);
}

/** insert 被拒以后最多等多久服务器那一行（同步一轮拉取一般几秒；离线时等不到就算了） */
export const AI_SWITCH_SETTLE_MS = 120_000;

/**
 * 同 writeAiSwitch；这次是 insert 时在后台盯着：那一项被服务器拒了，就等同步把服务器上那一行拉进本机集合，再 patch 一次（CONSENT-sugg ②）。
 * 返回值是第一次写的结果（不等后台那一步）。settleMs 到了还没等到就停，不重试第二次
 */
export async function writeAiSwitchSettled(
  sw: AiSwitch,
  o: { newId?: () => string; settleMs?: number } = {},
): Promise<WriteResult> {
  const r = await writeAiSwitch(sw, o.newId);
  const item = r.ok ? r.item : null;
  const outbox = getBoot()?.outbox;
  if (!item || item.op !== 'insert' || !outbox) return r;
  let offRow: () => void = () => undefined;
  let stopped = false;
  /** 不再等服务器那一行（到点或已 patch）；事件监听不在这里摘 */
  const stop = (): void => {
    stopped = true;
    clearTimeout(timer);
    offRow();
  };
  const timer = setTimeout(stop, o.settleMs ?? AI_SWITCH_SETTLE_MS);
  /** 服务器那一行到了：按它 patch，停 */
  const tryPatch = (): boolean => {
    const row = rowOf(sw.key, item.id);
    if (!row) return false;
    stop();
    void writeOn(sw, row, () => crypto.randomUUID()).catch(() => undefined);
    return true;
  };
  const offEvent = outbox.onEvent((e) => {
    if ((e.type !== 'error' && e.type !== 'rejected') || e.item.op_id !== item.op_id) return;
    offEvent();
    // 先回滚（删掉被拒的那一项和本机那一行），再等服务器那一行补 patch；删失败（库已关）照样往下等
    const drop = e.type === 'error' ? outbox.discardUnlessInflight(item.op_id) : Promise.resolve(false);
    void drop.catch(() => false).then(() => {
      if (!stopped && !tryPatch()) offRow = settings().subscribe(() => void tryPatch());
    });
  });
  return r;
}
